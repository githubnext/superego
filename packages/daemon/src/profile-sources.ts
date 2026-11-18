// Profile sources: where the user's own profiles come from beyond `~/.superego/profiles`, the way Pi installs packages.
// A source is a git repo, `git:<host>/<owner>/<repo>[@ref]`, cloned to `~/.superego/sources/<host>/<owner>/<repo>`, or a
// folder (`~/…` or absolute), read in place. Its profiles are its `profiles/<name>/profile.ts`. Installing one is the
// user's choice, so its profiles are the user's: they run without being allowed, as `~/.superego/profiles`' do. That
// means trusting its code.
//
// The list is `~/.superego/profile-sources.json`, `{ "sources": [...] }` in the order installed, and read again when it
// changes (by hand, say). Each source's `profiles` is a user root after `~/.superego/profiles` (see profiles.ts).
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { RpcError, type ProfileSourceInfo } from '@superego/protocol'
import { allUserProfiles, userProfiles, type UserRoot } from './profiles.ts'
import { writeAtomic } from './write-atomic.ts'

/** A source as installed: its spec (as written in the list), and where its files are. */
export type Source =
  | { kind: 'git'; spec: string; host: string; owner: string; repo: string; ref?: string; dir: string }
  | { kind: 'local'; spec: string; dir: string }

/** How long a clone or a pull may take. */
const GIT_TIMEOUT = 120_000
const SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * A source from what the user wrote: `git:<host>/<owner>/<repo>[@ref]` (or `https://<host>/<owner>/<repo>[.git]`), else
 * a folder, `~/…` or absolute. Its spec is as the list keeps it: a git URL as `git:…`, a folder as written.
 */
export function parseSource(spec: string, dataDir: string, home = homedir()): Source {
  const written = spec.trim()
  if (!written) throw new RpcError('usage', 'Name a source: git:<host>/<owner>/<repo>[@ref], or a folder')
  const git = /^git:(?:https?:\/\/)?(.+)$/.exec(written) ?? /^https?:\/\/(.+)$/.exec(written)
  if (git) {
    const [path, ref, ...more] = git[1]!.split('@')
    const [host, owner, rawRepo, ...rest] = path!.replace(/\/+$/, '').split('/')
    const repo = rawRepo?.replace(/\.git$/, '')
    if (more.length || rest.length || ref === '' || ![host, owner, repo].every((s) => s && SEGMENT.test(s) && s !== '.' && s !== '..')) {
      throw new RpcError('usage', `${written} isn't a git source: git:<host>/<owner>/<repo>[@ref]`)
    }
    return { kind: 'git', spec: `git:${host}/${owner}/${repo}${ref ? `@${ref}` : ''}`, host: host!, owner: owner!, repo: repo!, ...(ref ? { ref } : {}), dir: join(dataDir, 'sources', host!, owner!, repo!) }
  }
  const expanded = written.replace(/^~(?=\/|$)/, home)
  if (!isAbsolute(expanded)) throw new RpcError('usage', `${written}: a source is git:<host>/<owner>/<repo>[@ref], or a folder as ~/… or an absolute path`)
  return { kind: 'local', spec: written, dir: resolve(expanded) }
}

/** Whether two sources are the same: one repo (whatever its ref), or one folder. */
const sameSource = (a: Source, b: Source) => a.dir === b.dir

const isDir = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }

/** Run git, failing with what it said. */
function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((done, fail) => {
    // Never a prompt for a password: there's no one at the daemon's terminal to answer it.
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (!error) return done(stdout.trim())
      const said = stderr.trim() || error.message
      fail(new Error(error.killed ? `git ${args[0]} took over ${GIT_TIMEOUT / 1000}s` : said))
    })
  })
}

const urlOf = (source: Extract<Source, { kind: 'git' }>) => `https://${source.host}/${source.owner}/${source.repo}.git`

export type UpdateResult = { source: string; result: 'updated' | 'current' | 'cloned' | 'pinned' | 'local' | 'failed'; from?: string; to?: string; error?: string }

export class ProfileSources {
  #dataDir: string
  #path: string
  #own: UserRoot
  #sources: Source[] = []
  /** What's wrong with the list file, while it is: its sources aren't read, nor is it written over. */
  #problem: string | undefined
  #mtime = -1
  /** Installs, removals and updates, one at a time. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string) {
    this.#dataDir = dataDir
    this.#path = join(dataDir, 'profile-sources.json')
    this.#own = { dir: join(dataDir, 'profiles') }
  }

  /** Where the list is kept. */
  get path() { return this.#path }

  /** The sources, as the list is now (read again once it changed). */
  list(): Source[] {
    let mtime: number
    try { mtime = statSync(this.#path).mtimeMs } catch { mtime = 0 }
    if (mtime === this.#mtime) return this.#sources
    this.#mtime = mtime
    this.#sources = []
    this.#problem = undefined
    if (!mtime) return this.#sources
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as { sources?: unknown }
      if (!Array.isArray(parsed.sources) || !parsed.sources.every((s) => typeof s === 'string')) throw new Error('expected { "sources": [ "git:…" or a folder, … ] }')
      this.#sources = parsed.sources.map((spec) => parseSource(spec as string, this.#dataDir))
    } catch (error) {
      this.#problem = `${this.#path}: ${(error as Error).message}`
      console.error(`Profile sources: ${this.#problem}`)
    }
    return this.#sources
  }

  /** What's wrong with the list file, if anything. */
  problem() { this.list(); return this.#problem }

  /** The user's roots: `~/.superego/profiles`, then each source's `profiles`, in order. */
  roots(): UserRoot[] {
    return [this.#own, ...this.list().map((s) => ({ dir: join(s.dir, 'profiles'), source: s.spec }))]
  }

  /** Each source, its state and its profiles (which ones an earlier root shadows). */
  async describe(): Promise<ProfileSourceInfo[]> {
    const roots = this.roots()
    const used = new Map(userProfiles(roots).map((p) => [p.name, p.dir]))
    const all = allUserProfiles(roots)
    return Promise.all(this.list().map(async (source): Promise<ProfileSourceInfo> => {
      const profiles = all.filter((p) => p.source === source.spec).map((p) => ({ name: p.name, dir: p.dir, ...(used.get(p.name) !== p.dir ? { shadowedBy: used.get(p.name)! } : {}) }))
      const state = !isDir(source.dir) ? (source.kind === 'git' ? 'not-cloned' : 'missing') : isDir(join(source.dir, 'profiles')) ? 'ready' : 'no-profiles'
      const commit = source.kind === 'git' && state !== 'not-cloned' ? await git(['rev-parse', '--short', 'HEAD'], source.dir).catch((error: Error) => {
        console.error(`Profile source ${source.spec}: ${error.message}`)
        return undefined
      }) : undefined
      return { source: source.spec, kind: source.kind, dir: source.dir, state, ...(source.kind === 'git' && source.ref ? { ref: source.ref } : {}), ...(commit ? { commit } : {}), profiles }
    }))
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work)
    // The queue only orders the work: each caller hears its own failure.
    this.#queue = next.catch(() => {})
    return next
  }

  async #save(sources: Source[]) {
    await writeAtomic(this.#path, JSON.stringify({ sources: sources.map((s) => s.spec) }, null, 2) + '\n', 0o644)
    this.#sources = sources
    this.#mtime = statSync(this.#path).mtimeMs
  }

  #writable() {
    const problem = this.problem()
    if (problem) throw new RpcError('invalid', `Profile sources: ${problem}`, { hint: 'Fix the file (or remove it), then try again.' })
    return this.list()
  }

  /** Find an installed source, by anything naming it (a git source with or without its ref). */
  find(spec: string): Source {
    const wanted = parseSource(spec, this.#dataDir)
    const found = this.list().find((s) => sameSource(s, wanted))
    if (!found) {
      const installed = this.list().map((s) => s.spec)
      throw new RpcError('not_found', `No profile source ${spec}${installed.length ? `. Installed: ${installed.join(', ')}` : ''}`)
    }
    return found
  }

  async #clone(source: Extract<Source, { kind: 'git' }>) {
    await rm(source.dir, { recursive: true, force: true })
    try {
      await git(['clone', '--quiet', urlOf(source), source.dir])
      if (source.ref) await git(['checkout', '--quiet', source.ref], source.dir)
    } catch (error) {
      await this.#removeClone(source)
      throw new RpcError('failed', `Couldn't clone ${source.spec}: ${(error as Error).message}`)
    }
    if (!isDir(join(source.dir, 'profiles'))) {
      await this.#removeClone(source)
      throw new RpcError('invalid', `${source.spec} has no profiles/ folder: a source's profiles are its profiles/<name>/profile.ts`)
    }
  }

  /** A clone gone, and the folders it leaves empty (its owner's, its host's) up to sources/. */
  async #removeClone(source: Source) {
    await rm(source.dir, { recursive: true, force: true })
    const top = join(this.#dataDir, 'sources')
    for (let dir = dirname(source.dir); dir.startsWith(top + '/'); dir = dirname(dir)) {
      if (!isDir(dir) || readdirSync(dir).length) break
      rmdirSync(dir)
    }
  }

  /**
   * Add a source and fetch it (a git one cloned). Again: nothing changes, but a git source not cloned yet is cloned.
   * The same repo at another ref takes that ref's place, cloned again.
   */
  install(spec: string): Promise<{ source: ProfileSourceInfo; changed: boolean }> {
    return this.#serial(async () => {
      const sources = this.#writable()
      const source = parseSource(spec, this.#dataDir)
      const had = sources.find((s) => sameSource(s, source))
      if (source.kind === 'local') {
        if (!isDir(source.dir)) throw new RpcError('not_found', `No folder at ${source.dir}`)
        if (!isDir(join(source.dir, 'profiles'))) throw new RpcError('invalid', `${source.dir} has no profiles/ folder: a source's profiles are its profiles/<name>/profile.ts`)
      } else if (!had || had.spec !== source.spec || !isDir(source.dir)) {
        await this.#clone(source)
      }
      const changed = had?.spec !== source.spec
      if (changed) await this.#save(had ? sources.map((s) => s === had ? source : s) : [...sources, source])
      const info = (await this.describe()).find((s) => s.source === source.spec)!
      return { source: info, changed }
    })
  }

  /** Drop a source; a git one's clone goes with it. */
  remove(spec: string): Promise<{ source: string; dir: string; deleted: boolean }> {
    return this.#serial(async () => {
      const sources = this.#writable()
      const source = this.find(spec)
      await this.#save(sources.filter((s) => s !== source))
      if (source.kind === 'git') await this.#removeClone(source)
      return { source: source.spec, dir: source.dir, deleted: source.kind === 'git' }
    })
  }

  /**
   * Bring git sources up to date (`git pull --ff-only`), or the one named: one not cloned yet is cloned. A pinned one
   * (`@ref`) stays as it is, as does a folder. Each one's failure is its own; one named that fails, fails.
   */
  update(spec?: string): Promise<UpdateResult[]> {
    return this.#serial(async () => {
      const targets = spec ? [this.find(spec)] : this.list()
      const results: UpdateResult[] = []
      for (const source of targets) {
        if (source.kind === 'local') { results.push({ source: source.spec, result: 'local' }); continue }
        try {
          if (!isDir(source.dir)) { await this.#clone(source); results.push({ source: source.spec, result: 'cloned' }); continue }
          if (source.ref) { results.push({ source: source.spec, result: 'pinned' }); continue }
          const from = await git(['rev-parse', '--short', 'HEAD'], source.dir)
          await git(['pull', '--ff-only', '--quiet'], source.dir)
          const to = await git(['rev-parse', '--short', 'HEAD'], source.dir)
          results.push({ source: source.spec, result: from === to ? 'current' : 'updated', from, to })
        } catch (error) {
          const message = (error as Error).message
          console.error(`Profile source ${source.spec}: ${message}`)
          if (spec) throw new RpcError('failed', `Couldn't update ${source.spec}: ${message}`)
          results.push({ source: source.spec, result: 'failed', error: message })
        }
      }
      return results
    })
  }
}


// A folder's own Claude Code configuration, and whether the user allowed it. Claude Code loads a project's
// (`settingSources` 'project' and 'local') from the folder it runs in and every folder above it, short of `/` (some of
// it from the folder alone: taken from all of them here, which is only stricter): its `.claude/` (settings with hooks,
// statusLine and apiKeyHelper commands, permissions and env; hook scripts; agents, skills and commands that can carry
// hooks of their own; `CLAUDE.md` and `rules/`), `.mcp.json`, and the instructions it follows (`CLAUDE.md`,
// `CLAUDE.local.md`) with every file they import (`@path`, up to five deep). In a cloned repository that's the
// repository's code and words, run and followed as the user from the first message, so a turn loads it only for a
// folder the user allowed as it is now: a change to any of it (a file added too, or one an import names showing up)
// asks again, as a project's profile does. Not in it: a file elsewhere that a hook's command names (the command is, for
// whoever allows it to read); nor a `CLAUDE.md` in a folder below, which Claude Code reads only as it works on a file
// there, as part of what it reads there anyway, unallowed as the rest of it.
//
// Skills in folders below are in it, though: Claude Code finds a `.claude/skills` below its folder as it works on a file
// there, and loads it with the project's settings (only then), and a skill runs commands of its own (its hooks, and
// `!` lines) once it's used. So they're fingerprinted with the rest, found as cheaply as Claude Code would find them:
// in a git repository, what git lists (`git ls-files`: tracked, and untracked but not ignored, which is what Claude Code
// loads; a repository inside it looked into the same way), else by walking the folder, up to `WALK_LIMIT` folders, when
// it has configuration of its own. A folder too big to walk can't be allowed: what's below it could carry a skill
// nobody looked at.
//
// What's allowed is what Claude Code loads: the folders above the project's too (Superego's own project files stop at
// its top: project-files.ts in the daemon). So where another user could put one of those files there (a folder on the
// way, or a file, that's writable by others or not the user's: /tmp, say), nothing makes the allowing hold: such a
// folder's settings can't be allowed, and Claude Code runs there with the user's own only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { trusted } from '@superego/daemon'
import type { ProjectConfig } from './shared.ts'

/** A folder as it really is (symlinks resolved), where it exists. */
export const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

const isFile = (path: string) => { try { return statSync(path).isFile() } catch { return false } }
const isDirectory = (path: string) => { try { return statSync(path).isDirectory() } catch { return false } }

/**
 * The files under `dir`, symlinks followed (a folder once): not a repository's or packages' folders, nor, at the top
 * of `.claude/`, Claude Code's own checkouts (`claude --worktree`), which aren't configuration.
 */
function filesUnder(dir: string, top = true, seen = new Set<string>()): string[] {
  const at = real(dir)
  if (seen.has(at)) return []
  seen.add(at)
  const files: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) {
      if (entry !== '.git' && entry !== 'node_modules' && !(top && entry === 'worktrees')) files.push(...filesUnder(path, false, seen))
    } else if (stat.isFile()) files.push(path)
  }
  return files
}

/** How many folders below a folder that isn't a git repository are walked looking for skills, before giving up. */
export const WALK_LIMIT = 20_000
/** A file in a `.claude/skills` folder below the top (`a/.claude/skills/x/SKILL.md`), by its path from the top. */
const NESTED_SKILL = /(^|\/)[^/]+\/\.claude\/skills\//
const isNestedSkill = (path: string) => NESTED_SKILL.test(path) && !path.startsWith('.claude/')

/** What git lists in `dir` (its path from there, NUL-separated), or undefined when it isn't in a repository. */
function gitList(dir: string, args: string[]): string[] | undefined {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files', '-z', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean)
  } catch {
    // Not a repository (or no git): walked instead.
    return undefined
  }
}

/**
 * The files in `.claude/skills` folders below `dir` (not its own `.claude`), as Claude Code would find them while working
 * there: not those git ignores, nor in `node_modules` (in a folder another repository ignores, none: Claude Code skips
 * them too). `tooMany` when `dir` isn't in a repository and has more folders than are walked (`limit`); `walk: false`,
 * not walked at all.
 */
export function nestedSkills(dir: string, { walk: walking = true, limit = WALK_LIMIT } = {}): { files: string[]; tooMany?: true } {
  const files: string[] = []
  const tracked = gitList(dir, ['--stage'])
  if (tracked) {
    // `<mode> <object> <stage>\t<path>`: a submodule (160000) is another repository, looked into the same way.
    for (const line of tracked) {
      const [info = '', path = ''] = line.split('\t')
      if (info.startsWith('160000')) files.push(...nestedSkills(join(dir, path)).files.map((f) => join(path, f)))
      else if (isNestedSkill(path)) files.push(path)
    }
    for (const path of gitList(dir, ['--others', '--exclude-standard']) ?? []) {
      // A repository of its own inside it, untracked: listed as its folder.
      if (path.endsWith('/')) files.push(...nestedSkills(join(dir, path)).files.map((f) => join(path, f)))
      else if (isNestedSkill(path)) files.push(path)
    }
    return { files: [...new Set(files)].filter((f) => isFile(join(dir, f))).sort() }
  }
  if (!walking) return { files: [] }
  let folders = 0
  const walk = (at: string, rel: string): boolean => {
    let entries
    try { entries = readdirSync(at, { withFileTypes: true }) } catch { return true }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.name === '.claude' && rel) {
        const skills = join(at, '.claude', 'skills')
        if (isDirectory(skills)) files.push(...filesUnder(skills, false).map((f) => relative(dir, f)))
        continue
      }
      if (++folders > limit) return false
      if (!walk(join(at, entry.name), path)) return false
    }
    return true
  }
  if (!walk(dir, '')) return { files: [], tooMany: true }
  return { files: files.sort() }
}

/** How deep Claude Code follows imports: a file imported by one imported by… up to this many. */
const IMPORT_DEPTH = 5
/** An import, as Claude Code finds them: `@` at a line's start or after a space, up to the next space (`\ ` escapes one). */
const IMPORT = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g

/**
 * The files `text` (a `CLAUDE.md`, or a file one imports, in `dir`) imports, as Claude Code reads them: relative to
 * `dir`, from the home folder (`~/`) or whole. Wherever they are: Claude Code reads those outside its folder only
 * where the user said so in its own settings, but a fingerprint covering them is merely stricter. Inside code too,
 * which Claude Code skips: the same.
 */
export function importsOf(text: string, dir: string): string[] {
  const paths: string[] = []
  for (const [, given = ''] of text.matchAll(IMPORT)) {
    const path = given.split('#')[0]!.replaceAll('\\ ', ' ')
    if (!path || path === '/' || !/^(\.\/|~\/|\/|[a-zA-Z0-9._-])/.test(path)) continue
    paths.push(path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(dir, path))
  }
  return paths
}

/** Whether a file in a `.claude/` (at `path` in it) is instructions Claude Code follows, not settings. */
const instructionsIn = (path: string) => path === 'CLAUDE.md' || path.startsWith('rules/')

/**
 * The Claude Code configuration `cwd` has of its own, if any: what its project and local settings would load. The
 * user's own `.claude` (`CLAUDE_CONFIG_DIR`, and the home folder's `~/.claude`: the user's, whatever reads it) isn't
 * a project's, whatever folder it's in.
 */
export function projectConfig(cwd: string, userConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): ProjectConfig | undefined {
  const folder = resolve(cwd)
  // Where Claude Code runs: the folder as it really is.
  const at = real(folder)
  const users = new Set([real(userConfig), real(join(homedir(), '.claude'))])
  /** What it loads, each file whether it's instructions (rather than settings): from the folder up, nearest first. */
  const found = new Map<string, boolean>()
  /** Files imported that aren't there: one showing up would be loaded too. */
  const absent = new Set<string>()
  let unsafe: string | undefined
  const checked = new Set<string>()
  /** Whether only the user could have put `path` there: it, and every folder it's in. */
  const check = (path: string) => {
    for (let p = path; !checked.has(p) && dirname(p) !== p; p = dirname(p)) {
      checked.add(p)
      if (!unsafe && !trusted(p)) unsafe = p
    }
  }
  check(at)
  for (let dir = at; dirname(dir) !== dir; dir = dirname(dir)) {
    const claude = join(dir, '.claude')
    if (isDirectory(claude) && !users.has(real(claude))) {
      for (const file of filesUnder(claude)) found.set(file, instructionsIn(relative(claude, file)))
    }
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md']) if (isFile(join(dir, name))) found.set(join(dir, name), true)
    if (isFile(join(dir, '.mcp.json'))) found.set(join(dir, '.mcp.json'), false)
  }
  // What the instructions import, and what that imports.
  const follow = (file: string, depth: number) => {
    if (depth >= IMPORT_DEPTH) return
    for (const path of importsOf(readFileSync(file, 'utf8'), dirname(file))) {
      if (found.has(path) || absent.has(path)) continue
      if (!isFile(path)) { absent.add(path); continue }
      found.set(path, true)
      follow(path, depth + 1)
    }
  }
  for (const [file, instructions] of [...found]) if (instructions) follow(file, 0)
  // Skills below it, which load with the rest once it's allowed. A folder outside git is walked only when it has
  // configuration of its own: without it, Claude Code loads none of the folder's, those below included.
  const below = nestedSkills(at, { walk: found.size > 0 })
  for (const file of below.files) found.set(join(at, file), false)
  if (!found.size) return undefined

  const nameOf = (file: string) => file.startsWith(at + '/') ? relative(at, file) : file
  const hash = createHash('sha256')
  const files = [...found.keys()].map((file) => {
    check(file)
    const name = nameOf(file)
    hash.update(name).update('\0').update(createHash('sha256').update(readFileSync(file)).digest('hex')).update('\0')
    return name
  })
  for (const file of absent) hash.update(nameOf(file)).update('\0absent\0')
  return {
    cwd: folder, files, hash: hash.digest('hex').slice(0, 16), onlyInstructions: [...found.values()].every(Boolean),
    ...(unsafe ? { unsafe } : {}), ...(below.tooMany ? { tooBig: true as const } : {}),
  }
}

/** The folders whose Claude Code configuration the user allowed, each at the hash it was allowed at: a file in the data folder. */
export class ProjectAllowances {
  #path: string
  #allowed: Record<string, string> = {}
  constructor(path: string) { this.#path = path }
  async load() {
    let text: string
    try { text = await readFile(this.#path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    this.#allowed = JSON.parse(text) as Record<string, string>
  }
  /** Whether `config` is allowed as it is (never where another user could change it). */
  allowed(config: ProjectConfig) { return !config.unsafe && !config.tooBig && this.#allowed[real(config.cwd)] === config.hash }
  /** Whether its folder was allowed as it was before: it changed since. */
  changed(config: ProjectConfig) { const hash = this.#allowed[real(config.cwd)]; return hash !== undefined && hash !== config.hash }
  async allow(config: ProjectConfig) {
    this.#allowed[real(config.cwd)] = config.hash
    await mkdir(dirname(this.#path), { recursive: true })
    const temp = `${this.#path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.#allowed, null, 2) + '\n', { mode: 0o600 })
    await rename(temp, this.#path)
  }
}

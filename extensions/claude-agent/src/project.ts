// A folder's own Claude Code configuration, and whether the user allowed it. Claude Code loads a project's settings
// (`settingSources` 'project' and 'local') from the folder it runs in: its `.claude/` (settings with hooks, statusLine
// and apiKeyHelper commands, permissions and env; hook scripts; agents, skills and commands that can carry hooks of
// their own) and `.mcp.json` there and in every folder above it. In a cloned repository that's the repository's code,
// run as the user on the first message, so a turn loads it only for a folder the user allowed as it is now: a change
// to any of it asks again, as a project's profile does. Not in it: a file elsewhere that a hook's command names (the
// command is, for whoever allows it to read).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

/** A folder's Claude Code configuration as it is now: its files (from the folder, or absolute when above it), and their hash. */
export type ProjectConfig = { cwd: string; files: string[]; hash: string }

const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }

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

/**
 * The Claude Code configuration `cwd` has of its own, if any: what its project settings would load. The user's own
 * `.claude` (`CLAUDE_CONFIG_DIR`, else `~/.claude`) isn't a project's, whatever folder it's in.
 */
export function projectConfig(cwd: string, userConfig = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): ProjectConfig | undefined {
  const folder = resolve(cwd)
  const found: string[] = []
  const claude = join(folder, '.claude')
  if (existsSync(claude) && statSync(claude).isDirectory() && real(claude) !== real(userConfig)) found.push(...filesUnder(claude))
  for (let dir = folder; ; dir = dirname(dir)) {
    const mcp = join(dir, '.mcp.json')
    if (existsSync(mcp) && statSync(mcp).isFile()) found.push(mcp)
    if (dirname(dir) === dir) break
  }
  if (!found.length) return undefined
  const hash = createHash('sha256')
  const files = found.map((file) => {
    const name = file.startsWith(folder + '/') ? relative(folder, file) : file
    hash.update(name).update('\0').update(createHash('sha256').update(readFileSync(file)).digest('hex')).update('\0')
    return name
  })
  return { cwd: folder, files, hash: hash.digest('hex').slice(0, 16) }
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
  /** Whether `config` is allowed as it is. */
  allowed(config: ProjectConfig) { return this.#allowed[real(config.cwd)] === config.hash }
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

// The user's own Claude Code, as a Claude Agent thread runs it: their installed `claude` (never one Superego ships), in
// an environment without Anthropic credentials, so it uses the sign-in the user made with its own `/login`.
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { userInfo } from 'node:os'

/**
 * Variables that would make Claude Code bill something other than the user's own sign-in: an API key or token, another
 * endpoint, or a cloud provider. Every `ANTHROPIC_*` goes too (keys, tokens, base URLs, models).
 */
const CREDENTIALS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
])
/** The daemon's own: it runs as Electron's Node, which nothing it starts should be. */
const OURS = /^ELECTRON_(RUN_AS_NODE|RENDERER_URL|NO_ATTACH_CONSOLE)$/

/** The environment `claude` runs with: the daemon's, without Anthropic credentials or the daemon's own variables. */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith('ANTHROPIC_') || CREDENTIALS.has(key) || OURS.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * The PATH of the user's login, interactive shell (where mise, Homebrew and npm put `claude`), if there's a shell to
 * ask. Its PATH, not its `command -v claude`: that answers with an alias (`claude --dangerously-skip-permissions`, say)
 * when the user has one, which isn't a file to run, and would carry flags Superego must not pass.
 */
function shellPath(): Promise<string | undefined> {
  let shell = process.env.SHELL
  if (!shell) try { shell = userInfo().shell ?? undefined } catch { /* no passwd entry: no shell to ask */ }
  if (!shell) return Promise.resolve(undefined)
  // Between markers: an interactive shell's startup files may print what they like.
  const mark = '__superego_path__'
  return new Promise((done) => {
    execFile(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], { timeout: 5000, env: claudeEnv() }, (_error, stdout) => {
      done(String(stdout ?? '').match(new RegExp(`${mark}(.*?)${mark}`, 's'))?.[1] || undefined)
    })
  })
}

/** The first executable `claude` on `path`, if any. */
export async function onPath(path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, 'claude')
    if (await access(file, constants.X_OK).then(() => true, () => false)) return file
  }
  return undefined
}

/**
 * Where the user's `claude` is: `given` (`<APPID>_CLAUDE`, a `claude` of their choosing), else their login shell's,
 * else the daemon's PATH's. Undefined when it isn't installed.
 */
export async function findClaude(given?: string): Promise<string | undefined> {
  return given || (await onPath(await shellPath()) ?? await onPath(process.env.PATH))
}

/** The message for a machine without `claude`. */
export const NOT_INSTALLED = 'Claude Code isn\'t installed on this machine: see code.claude.com'

/** Claude Code's own error, said with what to do about it when it's one the user fixes in Claude Code. */
export function explain(error: string) {
  return /not logged in/i.test(error) ? 'Not logged in · run `claude` and `/login`' : error
}

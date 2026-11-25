// The user's own Claude Code, as a Claude Agent thread runs it: their installed `claude` (never one Superego ships), in
// an environment without Anthropic credentials, so it uses the sign-in the user made with its own `/login`.
import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { LoginEnv } from '@superego/daemon'
import type { ClaudeInstalled } from './shared.ts'

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

/** The first executable `claude` on `path`, if any. */
export async function onPath(path: string | undefined): Promise<string | undefined> {
  for (const dir of (path ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, 'claude')
    if (await access(file, constants.X_OK).then(() => true, () => false)) return file
  }
  return undefined
}

/**
 * Where the user's `claude` is: `given` (`<APPID>_CLAUDE`, a `claude` of their choosing), else on their login shell's
 * PATH (`loginEnv`, the daemon's read of it: where mise, Homebrew and npm put it), else on the daemon's. Its PATH, not
 * its `command -v claude`: that answers with an alias (`claude --dangerously-skip-permissions`, say) when the user has
 * one, which isn't a file to run, and would carry flags Superego must not pass. Undefined when it isn't installed. When
 * the login shell couldn't be read, the daemon's PATH is looked on alone: found nowhere, why the shell couldn't be read
 * is the error, not that `claude` isn't installed.
 */
export async function findClaude(given: string | undefined, loginEnv: () => Promise<LoginEnv>): Promise<string | undefined> {
  if (given) return given
  const shell = await loginEnv()
  const found = ('env' in shell ? await onPath(shell.env.PATH) : undefined) ?? await onPath(process.env.PATH)
  if (!found && 'error' in shell) throw new Error(shell.error)
  return found
}

/** What `executable` prints, run with `args` in `env` (stdout), or why it couldn't be run. */
function run(executable: string, args: string[], env: Record<string, string>): Promise<{ stdout: string; error?: Error }> {
  return new Promise((done) => {
    execFile(executable, args, { timeout: 15_000, env }, (error, stdout) => done({ stdout: String(stdout ?? ''), ...(error ? { error } : {}) }))
  })
}

/**
 * Claude Code on this machine as a thread would run it (`executable`, without Anthropic credentials): its version
 * (`claude --version`), and whether it's signed in as `claude auth status` says. Of its status only whether it's
 * signed in, how (`authMethod`: "claude.ai", say) and the plan it reports (`subscriptionType`) are kept: nothing else
 * it says, and never a credential.
 */
export async function checkClaude(executable: string, env: Record<string, string>): Promise<Omit<ClaudeInstalled, 'installed' | 'path'>> {
  const [version, status] = await Promise.all([run(executable, ['--version'], env), run(executable, ['auth', 'status', '--json'], env)])
  const number = /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0]
  let said: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown }
  try {
    said = JSON.parse(status.stdout) as typeof said
  } catch {
    const why = status.error?.message ?? `claude auth status said: ${status.stdout.trim().slice(0, 200)}`
    return { ...(number ? { version: number } : {}), loggedIn: false, error: why }
  }
  const how = typeof said.authMethod === 'string' && said.authMethod !== 'none' ? said.authMethod : undefined
  const plan = typeof said.subscriptionType === 'string' && said.subscriptionType ? said.subscriptionType : undefined
  return { ...(number ? { version: number } : {}), loggedIn: said.loggedIn === true, ...(how ? { how } : {}), ...(plan ? { plan } : {}) }
}

/** The message for a machine without `claude`. */
export const NOT_INSTALLED = 'Claude Code isn\'t installed on this machine: see code.claude.com'

/** Whether Claude Code's error says it isn't signed in. */
export const signedOut = (error: string) => /not logged in|please run \/login/i.test(error)

/** Claude Code's own error, said with what to do about it when it's one the user fixes in Claude Code. */
export function explain(error: string) {
  return signedOut(error) ? 'Not logged in · run `claude` and `/login`' : error
}

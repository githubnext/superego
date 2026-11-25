// The environment of the user's login, interactive shell: where people export their API keys (`~/.zshrc`), and where
// mise, Homebrew and npm put their programs on the PATH. A daemon the app started from the Dock, or one reached over
// ssh, doesn't have it. The daemon reads it once (`loginEnvReader`): keys a provider looks for are taken from it where
// the daemon's own environment has none (agent-settings.ts), and extensions have it (`superego.loginEnv()`: Claude
// Agent finds the user's `claude` on its PATH).
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

/**
 * What reading the login shell's environment found: its variables (none, when there's no shell to ask), or why it
 * couldn't be read.
 */
export type LoginEnv = { env: Record<string, string> } | { error: string }

/** The daemon's own variables: it runs as Electron's Node, which the shell it starts shouldn't. */
const OURS = /^ELECTRON_(RUN_AS_NODE|RENDERER_URL|NO_ATTACH_CONSOLE)$/

/**
 * What `env` says in the user's login, interactive shell (`shell`, else `$SHELL`, else their passwd entry's): nothing
 * when there's no shell to ask, why not when it fails or doesn't answer within `timeout` ms.
 */
export function readLoginEnv({ shell, timeout = 5000 }: { shell?: string; timeout?: number } = {}): Promise<LoginEnv> {
  let program = shell ?? process.env.SHELL
  if (!program) try { program = userInfo().shell ?? undefined } catch { /* no passwd entry: no shell to ask */ }
  if (!program) return Promise.resolve({ env: {} })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OURS.test(key)))
  // Between markers: an interactive shell's startup files may print what they like. NUL-separated: values span lines.
  // By its path: what the shell's PATH has is what's being read, so it can't be how `env` is found.
  const mark = '__superego_env__'
  return new Promise((done) => {
    execFile(program!, ['-ilc', `printf '${mark}'; /usr/bin/env -0; printf '${mark}'`], { timeout, env, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const between = String(stdout ?? '').split(mark)[1]
      if (between === undefined) {
        const why = error ? (error.killed ? `it didn't answer within ${Math.round(timeout / 1000)}s` : error.message) : 'it printed nothing'
        return done({ error: `Couldn't read your login shell's environment (${program}): ${why}` })
      }
      const out: Record<string, string> = {}
      for (const line of between.split('\0')) {
        const at = line.indexOf('=')
        if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
      }
      done({ env: out })
    })
  })
}

/**
 * `read` (readLoginEnv), once for everyone who asks: what it found is kept. One that failed (the shell didn't answer,
 * on a busy machine) is said on the console, and read again by the next to ask.
 */
export function loginEnvReader(read: () => Promise<LoginEnv> = readLoginEnv): () => Promise<LoginEnv> {
  let reading: Promise<LoginEnv> | undefined
  return () => reading ??= read().catch((error: Error) => ({ error: `Couldn't read your login shell's environment: ${error.message}` })).then((found) => {
    if ('error' in found) {
      console.error(found.error)
      reading = undefined
    }
    return found
  })
}

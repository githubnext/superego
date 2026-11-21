// The environment of the user's login, interactive shell: where people export their API keys (`~/.zshrc`). A daemon the
// app started from the Dock, or one reached over ssh, doesn't have it; the keys a provider looks for are read from it
// where the daemon's own environment has none (agent-settings.ts).
import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

/** The daemon's own variables: it runs as Electron's Node, which the shell it starts shouldn't. */
const OURS = /^ELECTRON_(RUN_AS_NODE|RENDERER_URL|NO_ATTACH_CONSOLE)$/

/**
 * What `env` says in the user's login, interactive shell (`shell`, else `$SHELL`, else their passwd entry's), or
 * nothing when there's no shell to ask or it doesn't answer within `timeout` ms. Said on the console when it fails.
 */
export function readLoginEnv({ shell, timeout = 5000 }: { shell?: string; timeout?: number } = {}): Promise<Record<string, string>> {
  let program = shell ?? process.env.SHELL
  if (!program) try { program = userInfo().shell ?? undefined } catch { /* no passwd entry: no shell to ask */ }
  if (!program) return Promise.resolve({})
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OURS.test(key)))
  // Between markers: an interactive shell's startup files may print what they like. NUL-separated: values span lines.
  const mark = '__superego_env__'
  return new Promise((done) => {
    execFile(program!, ['-ilc', `printf '${mark}'; env -0; printf '${mark}'`], { timeout, env, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const between = String(stdout ?? '').split(mark)[1]
      if (between === undefined) {
        console.error(`Reading the login shell's environment (${program}): ${error?.message ?? 'it printed nothing'}`)
        return done({})
      }
      const out: Record<string, string> = {}
      for (const line of between.split('\0')) {
        const at = line.indexOf('=')
        if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
      }
      done(out)
    })
  })
}

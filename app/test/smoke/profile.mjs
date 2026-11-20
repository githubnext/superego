// `superego app profile` against the running app (main/profile-renderer.ts, through the app's own socket): the window's
// renderer profiled through its debugger, what it showed, each process's CPU, a trace, and the files it says it wrote.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

export default async function profile(t) {
  const cli = new URL('../../bin/superego.ts', import.meta.url).pathname
  // Not execFileSync: the app answering is this process.
  const { stdout } = await promisify(execFile)('node', [cli, 'app', 'profile', '--seconds', '1', '--json'], { env: { ...process.env, SUPEREGO_APP: new URL('../..', import.meta.url).pathname } })
  const result = JSON.parse(stdout)
  const [window] = result.windows
  if (!window || window.error || !(window.profile?.ms > 500)) t.fail(`no profile of the window: ${JSON.stringify(window)}`)
  if (!(window.page?.nodes > 0) || !window.shown || !(window.metrics?.nodes > 0)) t.fail(`not what the window showed: ${JSON.stringify(window.page)}`)
  if (!result.processes.some((p) => p.pid === window.pid && p.name.startsWith('window'))) t.fail(`the window's process not named: ${JSON.stringify(result.processes)}`)
  for (const file of [result.summary, window.cpuprofile, result.trace]) if (!file || !existsSync(file)) t.fail(`${file} not written (${result.traceError ?? ''})`)
}

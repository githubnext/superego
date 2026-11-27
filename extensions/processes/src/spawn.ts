// Starting a process so it needs nothing from the daemon: its own session and process group, its output to its log
// file (appended to by the process itself, not through a pipe), stdin /dev/null, inside a small `sh` wrapper that writes
// its exit status to `<dir>/exit` once it ends. So it runs on while no daemon does, and how it ended is known after.
import { openSync, closeSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { spawnGroup, type SpawnedGroup } from '@superego/daemon/sdk'

/**
 * The wrapper: ignores TERM, HUP and INT itself (caught with a no-op, so the command it runs gets them as usual: a
 * caught signal is reset in a child) so that, stopped, it outlives its command long enough to write how it ended; then
 * exits with the command's status. `$1` is the exit file; the rest is the command.
 */
const WRAPPER = 'exit_file=$1; shift; trap : TERM HUP INT; "$@"; code=$?; printf \'%s\\n\' "$code" > "$exit_file.tmp" && mv -f "$exit_file.tmp" "$exit_file"; exit "$code"'

/** The user's shell. */
export function userShell(): string {
  let file = process.env.SHELL
  if (!file) try { file = userInfo().shell ?? undefined } catch { /* no passwd entry: sh */ }
  return file || '/bin/sh'
}

/**
 * How to run `command` in `shell`: as a login and interactive shell, so the user's PATH and aliases are there as in
 * their terminal; with job control off, so what it starts in the background stays in its process group (and stops
 * with it); and ending on SIGTERM, which an interactive shell otherwise ignores (a loop would last till the SIGKILL).
 */
export function shellArgs(shell: string, command: string): string[] {
  const name = shell.split('/').pop() ?? ''
  const off = name === 'fish' ? 'status job-control none; ' : /^(ba|z|k|da|mk)?sh$/.test(name) ? "set +m; trap 'exit 143' TERM; " : ''
  return ['-l', '-i', '-c', `${off}${command}`]
}

/**
 * What a process inherits from the daemon, less what is only the daemon's own (Electron run as Node, the dev server),
 * with colour asked for (it has no terminal, so tools would otherwise leave it out), then its own.
 */
export function processEnv(own: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !/^ELECTRON_(RUN_AS_NODE|RENDERER_URL|NO_ATTACH_CONSOLE)$|^OSC7577_TOKEN$/.test(key)) out[key] = value
  }
  return { ...out, FORCE_COLOR: '1', CLICOLOR_FORCE: '1', TERM: out.TERM || 'xterm-256color', LANG: out.LANG || 'en_US.UTF-8', ...own }
}

/** Where it writes how it ended. */
export const exitFile = (dir: string) => join(dir, 'exit')

/**
 * Start `command` in `cwd`, its output appended to `log`, as a group that outlives the daemon. The exit file of a run
 * before is removed first, so the one there after is this run's.
 */
export async function startDetached({ dir, log, command, cwd, env, grace, shell = userShell() }: {
  dir: string; log: string; command: string; cwd: string; env: Record<string, string>; grace: number; shell?: string
}): Promise<SpawnedGroup> {
  await rm(exitFile(dir), { force: true })
  const out = openSync(log, 'a')
  try {
    return spawnGroup('/bin/sh', ['-c', WRAPPER, 'superego-process', exitFile(dir), shell, ...shellArgs(shell, command)], {
      cwd, env: processEnv(env), stdio: ['ignore', out, out], grace, outlive: true,
    })
  } finally {
    // The process has its own: this one is the daemon's, done with.
    closeSync(out)
  }
}

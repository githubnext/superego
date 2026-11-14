// A command run as a tree that stops as one: what an extension that runs work (builds, checks, servers) needs to keep
// its word when it says the work stopped. Killing a shell doesn't kill what it started; a process group does.
//
//   const run = spawnGroup('sh', ['-c', command], { cwd, signal })
//   const { code, stopped } = await run.exited
//
// POSIX: the command leads a process group of its own; stopping it sends the group SIGTERM, then SIGKILL after `grace`,
// and `exited` waits until no process of the group is left. Windows has no process groups: there, stopping it ends its
// tree at once (`taskkill /T /F`), and `exited` waits for the command itself.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'

export type SpawnGroupOptions = Omit<SpawnOptions, 'detached' | 'signal'> & {
  /** Stops the whole group when it aborts: an action's cancel, `superego.signal` at teardown, or both (`AbortSignal.any`). */
  signal?: AbortSignal
  /** How long the group has after SIGTERM before SIGKILL, in ms: 5000 unless given. */
  grace?: number
}

/** How the command ended, once nothing of it is left. `stopped`: it was stopped (`stop()` or its signal), not done. */
export type GroupExit = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean; error?: Error }

export type SpawnedGroup = {
  child: ChildProcess
  /** Resolves once the command has exited and nothing it started in its group is left; never rejects. */
  exited: Promise<GroupExit>
  /** Stop the group (SIGTERM, then SIGKILL after the grace); resolves as `exited` does. Again, nothing more happens. */
  stop(): Promise<GroupExit>
}

const windows = process.platform === 'win32'
/** Groups still running, by their leader's pid: killed outright if the daemon exits before they're done. */
const live = new Set<number>()
let hooked = false

const send = (pid: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    // EPERM: some member is someone else's now (it changed user); the group is still there.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `command` with `args` as a process group of its own, stopped as one. When the command exits, anything it left
 * running in its group is stopped too, so `exited` means all of it is gone. What leaves the group on purpose (`setsid`,
 * a daemon that detaches) isn't followed.
 */
export function spawnGroup(command: string, args: readonly string[], options: SpawnGroupOptions = {}): SpawnedGroup {
  const { signal, grace = 5000, ...rest } = options
  const child = spawn(command, args, { windowsHide: true, ...rest, detached: !windows })
  const pid = child.pid
  if (pid !== undefined && !windows) {
    live.add(pid)
    if (!hooked) {
      hooked = true
      process.on('exit', () => { for (const group of live) send(group, 'SIGKILL') })
    }
  }

  let stopping: Promise<void> | undefined
  /** End what's left of the group: SIGTERM, SIGKILL after the grace, and wait until none of it is there. */
  const end = () => stopping ??= (async () => {
    if (pid === undefined) return
    if (windows) {
      if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    }
    if (!send(pid, 'SIGTERM')) return
    const kill = Date.now() + grace
    while (send(pid, 0)) {
      if (Date.now() >= kill) send(pid, 'SIGKILL')
      await sleep(20)
    }
  })()

  let stopped = false
  const exit = new Promise<Omit<GroupExit, 'stopped'>>((resolve) => {
    child.once('error', (error) => { if (child.pid === undefined) resolve({ code: null, signal: null, error }) })
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const exited = exit.then(async (result) => {
    // The command is done: what it left behind in its group goes with it.
    if (!windows) await end()
    else if (stopping) await stopping
    if (pid !== undefined) live.delete(pid)
    return { ...result, stopped }
  })

  const stop = () => {
    stopped = true
    void end()
    return exited
  }
  if (signal?.aborted) void stop()
  else if (signal) {
    const onAbort = () => void stop()
    signal.addEventListener('abort', onAbort, { once: true })
    void exited.then(() => signal.removeEventListener('abort', onAbort))
  }
  return { child, exited, stop }
}

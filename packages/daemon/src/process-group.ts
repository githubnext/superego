// A command run as a tree that stops as one: what an extension that runs work (builds, checks, servers) needs to keep
// its word when it says the work stopped. Killing a shell doesn't kill what it started; a process group does.
//
//   const run = spawnGroup('sh', ['-c', command], { cwd, signal })
//   const { code, stopped } = await run.exited
//
// POSIX: the command leads a process group of its own; stopping it sends the group SIGTERM, then SIGKILL after `grace`,
// and `exited` waits until no process of the group is left. Windows has no process groups: there, stopping it ends its
// tree at once (`taskkill /T /F`), and `exited` waits for the command itself.
//
// A group started with `outlive: true` isn't killed when the daemon exits: it runs on, and the next daemon takes it back
// by its leader's pid with `adoptGroup` (checking the pid is still that process with `processTable.info`'s start time).
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'

/** `spawn`'s options (bar `detached`, which the group is), and how to stop it. */
export type SpawnGroupOptions = Omit<SpawnOptions, 'detached' | 'signal'> & {
  /** Stops the whole group when it aborts: an action's cancel, `superego.signal` at teardown, or both (`AbortSignal.any`). */
  signal?: AbortSignal
  /** How long the group has after SIGTERM before SIGKILL, in ms: 5000 unless given. */
  grace?: number
  /**
   * (API ^5.18) Let it outlive the daemon: not killed as the daemon exits, and not holding it open (`unref`). Give it no
   * pipes (`stdio` to files or `'ignore'`): a pipe to a daemon that's gone breaks it. Take it back after a restart with
   * `adoptGroup`. POSIX only: on Windows it ends with the daemon all the same.
   */
  outlive?: boolean
}

/** How the command ended, once nothing of it is left. `stopped`: it was stopped (`stop()` or its signal), not done. */
export type GroupExit = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean; error?: Error }

/** A command `spawnGroup` started: its process, and when all of it has gone. */
export type SpawnedGroup = {
  /** The command's own process: its stdio, its pid. */
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

/** SIGTERM to the group, SIGKILL after `grace`, and resolve once none of it is there. */
async function endGroup(pid: number, grace: number) {
  if (!send(pid, 'SIGTERM')) return
  const kill = Date.now() + grace
  while (send(pid, 0)) {
    if (Date.now() >= kill) send(pid, 'SIGKILL')
    await sleep(20)
  }
}

/**
 * Run `command` with `args` as a process group of its own, stopped as one. When the command exits, anything it left
 * running in its group is stopped too, so `exited` means all of it is gone. What leaves the group on purpose (`setsid`,
 * a daemon that detaches) isn't followed.
 */
export function spawnGroup(command: string, args: readonly string[], options: SpawnGroupOptions = {}): SpawnedGroup {
  const { signal, grace = 5000, outlive = false, ...rest } = options
  const child = spawn(command, args, { windowsHide: true, ...rest, detached: !windows })
  const pid = child.pid
  if (outlive) child.unref()
  if (pid !== undefined && !windows && !outlive) {
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
    await endGroup(pid, grace)
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

/** A group `adoptGroup` took back: when it's gone, and how to stop it. */
export type AdoptedGroup = {
  /**
   * Resolves once its leader has exited and nothing of its group is left (what the leader left behind is stopped, as
   * `spawnGroup` does); never rejects. `stopped`: by `stop()` or the signal. Its exit code isn't known here (the leader
   * wasn't this process's child): keep it where the group writes it, a file say.
   */
  exited: Promise<{ stopped: boolean }>
  /** Stop the group (SIGTERM, then SIGKILL after the grace); resolves as `exited` does. */
  stop(): Promise<{ stopped: boolean }>
}

/**
 * (API ^5.18) Take back a group started with `spawnGroup(…, { outlive: true })` by an earlier daemon, by its leader's
 * pid. Check first that the pid is still that process (`processTable.info(pid)?.start` as recorded when it started): a
 * pid is reused. Whether its leader is still there is looked at every `poll` ms (1000). `signal` stops it, as
 * `spawnGroup`'s does. POSIX only.
 */
export function adoptGroup(pid: number, options: { grace?: number; poll?: number; signal?: AbortSignal } = {}): AdoptedGroup {
  const { grace = 5000, poll = 1000, signal } = options
  let stopped = false
  let stopping: Promise<void> | undefined
  let wake: (() => void) | undefined
  const end = () => stopping ??= endGroup(pid, grace)
  const alive = () => {
    try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
  }
  const exited = (async () => {
    while (alive() && !stopping) await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, poll).unref() })
    await end()
    return { stopped }
  })()
  const stop = () => {
    stopped = true
    void end()
    wake?.()
    return exited
  }
  if (signal?.aborted) void stop()
  else if (signal) {
    const onAbort = () => void stop()
    signal.addEventListener('abort', onAbort, { once: true })
    void exited.then(() => signal.removeEventListener('abort', onAbort))
  }
  return { exited, stop }
}

/** What the machine says of its processes. */
export type ProcessTable = {
  /** A running process's parent, and when it started (as text: another process given its pid starts at another). */
  info(pid: number): { ppid: number; start: string } | undefined
  /** Its working directory, if the machine says. */
  cwd(pid: number): string | undefined
}

/** (API ^5.18) The processes on this machine, as Linux (`/proc`) or any other Unix (`ps`) tells. Gone, or unreadable, is gone. */
export const processTable: ProcessTable = process.platform === 'linux'
  ? {
      info(pid) {
        let stat: string
        try { stat = readFileSync(`/proc/${pid}/stat`, 'latin1') } catch { return undefined /* gone */ }
        // After the name (in parentheses, which it may have in it too): state, ppid, … and the start time, 20th.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        return { ppid: Number(fields[1]), start: fields[19] ?? '' }
      },
      cwd(pid) {
        try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return undefined /* gone, or not ours to read */ }
      },
    }
  : {
      info(pid) {
        let out: string
        try { out = execFileSync('ps', ['-o', 'ppid=,lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return undefined /* gone: ps says so by failing */ }
        const line = /^\s*(\d+)\s+(.+?)\s*$/.exec(out)
        return line ? { ppid: Number(line[1]), start: line[2]! } : undefined
      },
      cwd: () => undefined,
    }

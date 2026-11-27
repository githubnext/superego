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
// by its leader's pid with `adoptGroup` (checking the pid is still that process with `processTable.lookup`'s start time,
// and the machine hasn't restarted since with `processTable.boot`).
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

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

/** A group `adoptGroup` took back: when it's gone, and how to stop it or let it go. */
export type AdoptedGroup = {
  /**
   * Resolves once its leader has exited and nothing of its group is left (what the leader left behind is stopped, as
   * `spawnGroup` does), or once it's released; never rejects. `stopped`: by `stop()` or the signal. `released`: by
   * `release()`, still running. Its exit code isn't known here (the leader wasn't this process's child): keep it where
   * the group writes it, a file say.
   */
  exited: Promise<AdoptedExit>
  /** Stop the group (SIGTERM, then SIGKILL after the grace); resolves as `exited` does. */
  stop(): Promise<AdoptedExit>
  /** Stop watching it and leave it running (a teardown: the next daemon takes it back); `exited` resolves `released`. */
  release(): void
}

/** How an adopted group's watch ended. */
export type AdoptedExit = { stopped: boolean; released?: true }

/** How often `adoptGroup` asks the machine again whether its leader is still the process it started as. */
const VERIFY_EVERY = 15_000

/**
 * (API ^5.18) Take back a group started with `spawnGroup(…, { outlive: true })` by an earlier daemon, by its leader's
 * pid. Check first that the pid is still that process (`await processTable.lookup(pid)` gives the `start` recorded when
 * it started): a pid is reused. It's watched while its leader is there and its group has members, every `poll` ms
 * (1000); given its `start`, the leader is checked to be that process again every 15s, so a pid reused meanwhile isn't
 * taken for it (nor signalled). `signal` stops it, as `spawnGroup`'s does; to let it run on past a teardown, don't give
 * one and `release()` it instead. POSIX only.
 */
export function adoptGroup(pid: number, options: { grace?: number; poll?: number; signal?: AbortSignal; start?: string } = {}): AdoptedGroup {
  const { grace = 5000, poll = 1000, signal, start } = options
  let stopped = false
  let released = false
  let stopping: Promise<void> | undefined
  let wake: (() => void) | undefined
  const end = () => stopping ??= endGroup(pid, grace)
  const alive = () => {
    try { process.kill(pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false }
    return send(pid, 0)
  }
  let verified = Date.now()
  /** Whether the pid is still the process that started then (a stranger's now: not ours to signal). */
  const same = async () => {
    if (start === undefined || Date.now() - verified < VERIFY_EVERY) return true
    verified = Date.now()
    const info = await processTable.lookup(pid)
    // Gone between the two looks: `alive` says so next.
    return !info || info.start === start
  }
  const exited = (async (): Promise<AdoptedExit> => {
    while (alive() && !stopping && !released) {
      await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, poll).unref() })
      if (!stopping && !released && !await same()) return { stopped }
    }
    if (released) return { stopped: false, released: true }
    await end()
    return { stopped }
  })()
  const stop = () => {
    if (released) return exited
    stopped = true
    void end()
    wake?.()
    return exited
  }
  const release = () => {
    if (stopping) return
    released = true
    wake?.()
  }
  if (signal?.aborted) void stop()
  else if (signal) {
    const onAbort = () => void stop()
    signal.addEventListener('abort', onAbort, { once: true })
    void exited.then(() => signal.removeEventListener('abort', onAbort))
  }
  return { exited, stop, release }
}

/** A process as the machine tells it: its parent, and when it started (as text: another process given its pid starts at another). */
export type ProcessEntry = { ppid: number; start: string }

/** What the machine says of its processes. */
export type ProcessTable = {
  /** A running process's parent, and when it started. Synchronous: on macOS it waits on `ps` (up to 2s); prefer `lookup`. */
  info(pid: number): ProcessEntry | undefined
  /** `info`, without blocking the daemon while the machine answers. */
  lookup(pid: number): Promise<ProcessEntry | undefined>
  /** Its working directory, if the machine says. */
  cwd(pid: number): string | undefined
  /**
   * Which boot of the machine this is: the same text until it next starts up (Linux's boot id, the BSDs' and macOS's
   * boot time). Undefined when the machine doesn't say. What a group recorded under another boot is gone.
   */
  boot(): Promise<string | undefined>
}

const PS_ARGS = (pid: number) => ['-o', 'ppid=,lstart=', '-p', String(pid)]
const psLine = (out: string): ProcessEntry | undefined => {
  const line = /^\s*(\d+)\s+(.+?)\s*$/.exec(out)
  return line ? { ppid: Number(line[1]), start: line[2]! } : undefined
}
/** A `/proc/<pid>/stat`'s parent and start (in clock ticks since boot: this boot's id before it, so a start never recurs). */
const statLine = (stat: string, boot: string): ProcessEntry => {
  // After the name (in parentheses, which it may have in it too): state, ppid, … and the start time, 20th.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return { ppid: Number(fields[1]), start: `${boot}:${fields[19] ?? ''}` }
}

const BOOT_ID = '/proc/sys/kernel/random/boot_id'
let linuxBoot: string | undefined
const linuxBootId = () => {
  if (linuxBoot === undefined) {
    try { linuxBoot = readFileSync(BOOT_ID, 'latin1').trim() } catch { linuxBoot = '' /* no procfs boot id (a container may hide it): the start alone */ }
  }
  return linuxBoot
}

let bsdBoot: Promise<string | undefined> | undefined
/** `kern.boottime`, as `sysctl` says it: `{ sec = 1700000000, usec = 123 } …`. */
const bsdBootTime = () => bsdBoot ??= new Promise((resolve) => {
  execFile('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 }, (error, out) => {
    if (error) {
      console.error("processTable: couldn't read the boot time (sysctl kern.boottime):", error.message)
      bsdBoot = undefined
      resolve(undefined)
      return
    }
    const sec = /sec\s*=\s*(\d+)/.exec(out)?.[1]
    resolve(sec)
  })
})

/** (API ^5.18) The processes on this machine, as Linux (`/proc`) or any other Unix (`ps`) tells. Gone, or unreadable, is gone. */
export const processTable: ProcessTable = process.platform === 'linux'
  ? {
      info(pid) {
        let stat: string
        try { stat = readFileSync(`/proc/${pid}/stat`, 'latin1') } catch { return undefined /* gone */ }
        return statLine(stat, linuxBootId())
      },
      async lookup(pid) {
        let stat: string
        try { stat = await readFile(`/proc/${pid}/stat`, 'latin1') } catch { return undefined /* gone */ }
        return statLine(stat, linuxBootId())
      },
      cwd(pid) {
        try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return undefined /* gone, or not ours to read */ }
      },
      boot: async () => linuxBootId() || undefined,
    }
  : {
      info(pid) {
        let out: string
        try { out = execFileSync('ps', PS_ARGS(pid), { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return undefined /* gone: ps says so by failing */ }
        return psLine(out)
      },
      lookup: (pid) => new Promise((resolve) => {
        // Gone: ps says so by failing.
        execFile('ps', PS_ARGS(pid), { encoding: 'utf8', timeout: 2000 }, (error, out) => resolve(error ? undefined : psLine(out)))
      }),
      cwd: () => undefined,
      boot: bsdBootTime,
    }

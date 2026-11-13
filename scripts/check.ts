#!/usr/bin/env node
// Runs a heavy check (tests, typecheck, smoke, screenshots) once a slot is free: at most SUPEREGO_CHECK_SLOTS (default
// 2; 0 for no limit) run at once on this machine, across every worktree, and none runs longer than its limit.
// `node scripts/check.ts [--timeout <VAR>=<seconds>] <command> [args…]`: the limit is $VAR if set, else the seconds
// given; without --timeout, SUPEREGO_CHECK_TIMEOUT (default 1200). A run over its limit is stopped with everything it
// started (its process group: SIGTERM, then SIGKILL 10s later) and exits 124.
//
// Each run takes a ticket, a file in ~/.superego/check-locks named by when it arrived, and runs once fewer than N live
// tickets are ahead of it: first come, first served. A ticket is live while its process is and keeps touching it; a
// crashed or killed run's ticket is cleared by whoever is waiting behind it. Commands run inside a slot don't take
// another (SUPEREGO_CHECK_SLOT is set for them).
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { basename, join } from 'node:path'

let argv = process.argv.slice(2)
let [limitVar, limitDefault] = ['SUPEREGO_CHECK_TIMEOUT', '1200']
if (argv[0] === '--timeout') {
  [limitVar, limitDefault] = argv[1]!.split('=') as [string, string]
  argv = argv.slice(2)
}
const limit = Number(process.env[limitVar] || limitDefault)
const [command, ...args] = argv
if (!command || !(limit > 0)) {
  console.error('usage: node scripts/check.ts [--timeout <VAR>=<seconds>] <command> [args…]')
  process.exit(2)
}
const slots = Number(process.env.SUPEREGO_CHECK_SLOTS ?? 2)
const dir = join(homedir(), '.superego', 'check-locks')
const HEARTBEAT = 5_000
const STALE = 60_000
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

let ticket: string | undefined
if (!process.env.SUPEREGO_CHECK_SLOT && slots > 0) await takeSlot()
run()

async function takeSlot() {
  mkdirSync(dir, { recursive: true })
  const name = `${String(Date.now()).padStart(15, '0')}-${process.pid}`
  ticket = join(dir, name)
  writeFileSync(ticket, JSON.stringify({ pid: process.pid, cwd: process.cwd(), command: [command, ...args].join(' ') }), { flag: 'wx' })
  process.on('exit', release)
  for (const signal of SIGNALS) process.on(signal, () => process.exit(128 + constants.signals[signal]))
  setInterval(() => { try { utimesSync(ticket!, new Date(), new Date()) } catch {} }, HEARTBEAT).unref()
  // Another run may have named its ticket just before this one but not written it yet.
  await sleep(100)
  let said = false
  for (;;) {
    const ahead = readdirSync(dir).filter((other) => /^\d+-\d+$/.test(other) && other < name).sort().filter((other) => live(join(dir, other)))
    if (ahead.length < slots) return
    if (!said) {
      const running = ahead.slice(0, slots).map(describe).join(', ')
      console.error(`waiting for a check slot… (running: ${running})`)
      said = true
    }
    await sleep(500 + Math.random() * 500)
  }
}

/** Whether a ticket's run is still there; a dead one's ticket is cleared. */
function live(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs < STALE) {
      const { pid } = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
      process.kill(pid, 0)
      return true
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    // Someone else's process, or a ticket its owner is writing right now.
    if (code === 'EPERM' || error instanceof SyntaxError) return true
  }
  try { unlinkSync(path) } catch {}
  return false
}

function describe(name: string): string {
  try {
    const { cwd, command } = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { cwd: string; command: string }
    return `${basename(command.split(' ')[0]!)} in ${basename(cwd)}`
  } catch {
    return '?'
  }
}

function release() {
  if (ticket) try { unlinkSync(ticket) } catch {}
  ticket = undefined
}

function run() {
  // In a process group of its own, so that stopping it stops everything it started (Electron and its helpers, say).
  const child = spawn(command!, args, { stdio: 'inherit', detached: true, env: { ...process.env, SUPEREGO_CHECK_SLOT: ticket ?? '1', SUPEREGO_CHECK_COMMAND: command } })
  const group = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal) } catch {} }
  // Ctrl-C reaches only this process now (the terminal's foreground group): it's passed on.
  for (const signal of SIGNALS) {
    process.removeAllListeners(signal)
    process.on(signal, () => group(signal))
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    console.error(`\n${[command, ...args].join(' ')}: still running after ${minutes(limit)}, stopping it (${limitVar}=<seconds> to allow longer)`)
    group('SIGTERM')
    setTimeout(() => group('SIGKILL'), 10_000).unref()
  }, limit * 1000)
  child.on('error', (error) => { console.error(`${command}: ${error.message}`); process.exit(127) })
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    if (timedOut) {
      // What's left of its group, if it shrugged off SIGTERM.
      group('SIGKILL')
      process.exit(124)
    }
    process.exit(signal ? 128 + constants.signals[signal] : code ?? 1)
  })
}

function minutes(seconds: number) {
  return seconds % 60 ? `${seconds}s` : `${seconds / 60} min`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

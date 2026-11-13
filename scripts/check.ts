#!/usr/bin/env node
// Runs a heavy check (tests, typecheck, smoke, screenshots) once a slot is free: at most SUPEREGO_CHECK_SLOTS (default
// 2; 0 for no limit) run at once on this machine, across every worktree. `node scripts/check.ts <command> [args…]`.
//
// Each run takes a ticket, a file in ~/.superego/check-locks named by when it arrived, and runs once fewer than N live
// tickets are ahead of it: first come, first served. A ticket is live while its process is and keeps touching it; a
// crashed or killed run's ticket is cleared by whoever is waiting behind it. Commands run inside a slot don't take
// another (SUPEREGO_CHECK_SLOT is set for them).
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { basename, join } from 'node:path'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/check.ts <command> [args…]')
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
  const child = spawn(command!, args, { stdio: 'inherit', env: { ...process.env, SUPEREGO_CHECK_SLOT: ticket ?? '1' } })
  // Ctrl-C reaches the child from the terminal too; a signal sent to this process alone is passed on.
  for (const signal of SIGNALS) {
    process.removeAllListeners(signal)
    process.on(signal, () => child.kill(signal))
  }
  child.on('error', (error) => { console.error(`${command}: ${error.message}`); process.exit(127) })
  child.on('exit', (code, signal) => process.exit(signal ? 128 + constants.signals[signal] : code ?? 1))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

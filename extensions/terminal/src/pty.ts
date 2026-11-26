// The PTY host: one shell per terminal pane, run by the daemon so it outlives the window (docs/design.md, principle 2). Each
// keeps what it printed last (its scrollback), so a window that attaches again (a reload, another client, a browser)
// sees it, and passes on what it prints to every window attached. A slow window slows the shell, as a real terminal's
// screen does: past HIGH bytes unread by any, the PTY is paused until all are below LOW. Its programs may say how to bring
// them back (OSC 7577: resume.ts), with the token each start of it hands its first process.
import { createRequire } from 'node:module'
import { RpcError } from '@superego/protocol'
import type { IPty } from '@lydell/node-pty'
import { ProgramStatus, REPLY } from './osc.ts'
import { newToken, ProgramResume, TOKEN, type Resume } from './resume.ts'

/** How much of what a terminal printed is kept for windows that attach later. */
export const SCROLLBACK = 1024 * 1024
const HIGH = 1024 * 1024
const LOW = 256 * 1024
/** How often the owners of what its programs reported are looked for, while there are any (ms). */
const SWEEP = 1000

export type SpawnOptions = { cwd: string; cols: number; rows: number; env: Record<string, string> }
export type Spawn = (file: string, args: string[], options: SpawnOptions) => IPty

type NodePty = typeof import('@lydell/node-pty')
let loaded: NodePty | Error | undefined
/**
 * node-pty, loaded when the first terminal starts: a native module (N-API, so the same build loads in Electron as Node
 * and in plain Node). Bundled, it's found beside the build (out/node_modules); from source, in node_modules.
 */
export function nodePty(): NodePty {
  if (!loaded) {
    try { loaded = createRequire(import.meta.url)('@lydell/node-pty') as NodePty } catch (error) { loaded = error as Error }
  }
  if (loaded instanceof Error) throw new RpcError('unavailable', `Terminals can't start on this machine: ${loaded.message}`)
  return loaded
}

export const spawnPty: Spawn = (file, args, { cwd, cols, rows, env }) =>
  nodePty().spawn(file, args, { name: 'xterm-256color', cwd, cols, rows, env })

/** A window attached to a terminal: what it's sent goes on its channel. */
export type Reader = { write(bytes: Uint8Array): Promise<void> }

/** What a terminal starts: its program (a shell) and its arguments, where and with what; `note`: said as it starts, dim. */
export type Launch = { file: string; args: string[]; cwd: string; env: Record<string, string>; note?: string }

export type TerminalOptions = {
  /** What it starts, asked each time it does. */
  launch(): Launch
  spawn: Spawn
  /** What its programs report (OSC 7501) changed. */
  onStatus(): void
  /** Its shell exited, saying `code`. */
  onExit(code: number): void
  /**
   * What its programs report would bring them back (OSC 7577) changed: none now, or this. Not given, and its programs
   * aren't offered a token, so don't report.
   */
  onResume?(resume: Resume | undefined): void
}

export class Terminal {
  readonly status = new ProgramStatus()
  #options: TerminalOptions
  #pty: IPty | undefined
  #chunks: Buffer[] = []
  #kept = 0
  /** Each attached window, and how much it was sent that it hasn't taken yet. */
  #readers = new Map<Reader, number>()
  #paused = false
  #size = { cols: 80, rows: 24 }
  #killed = false
  /** What its programs report of resuming them, this run (this token). */
  #resume: ProgramResume | undefined
  #sweeping: ReturnType<typeof setInterval> | undefined

  constructor(options: TerminalOptions) {
    this.#options = options
  }

  get running() { return Boolean(this.#pty) }
  get pid() { return this.#pty?.pid }
  get size() { return { ...this.#size } }

  /** Start the shell, unless it's running. Throws an `RpcError` when it can't. */
  start() {
    if (this.#pty || this.#killed) return
    const { file, args, cwd, env, note } = this.#options.launch()
    // Its own, new each start, for its first process only: never one the daemon was given.
    const token = this.#options.onResume ? newToken() : undefined
    if (note) this.note(note)
    let pty: IPty
    try {
      pty = this.#options.spawn(file, args, { cwd, ...this.#size, env: token ? { ...env, [TOKEN]: token } : env })
    } catch (error) {
      if (error instanceof RpcError) throw error
      throw new RpcError('unavailable', `Couldn't start ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.#pty = pty
    this.#paused = false
    this.#resume = token ? new ProgramResume({ token, root: pty.pid }) : undefined
    pty.onData((text) => this.#printed(Buffer.from(text, 'utf8')))
    pty.onExit(({ exitCode, signal }) => {
      if (this.#pty !== pty) return
      this.#pty = undefined
      if (this.status.reset()) this.#options.onStatus()
      this.#sweep(false)
      // Ended by the daemon (stopping, or its pane closed): what would bring its programs back is the daemon's to keep.
      if (this.#killed) return
      // Exited on its own: so did what ran in it.
      this.#resume = undefined
      this.#options.onResume?.(undefined)
      const code = signal ? 128 + signal : exitCode
      this.#options.onExit(code)
      // Said in the terminal, dim; a key starts it again.
      this.#print(Buffer.from(`\r\n\x1b[2m[Exited with ${code}. Press a key to start again.]\x1b[0m\r\n`))
    })
  }

  /**
   * Attach a window: it's sent a header (the length of what's replayed and the size it has, then `\n`), what the terminal printed before,
   * and from then on what it prints. Starts the shell if it isn't running. Returns the detach.
   */
  attach(reader: Reader): () => void {
    this.start()
    const kept = Buffer.concat(this.#chunks)
    this.#readers.set(reader, 0)
    this.#send(reader, Buffer.concat([Buffer.from(`${kept.length} ${this.#size.cols} ${this.#size.rows}\n`), kept]))
    return () => { this.#readers.delete(reader); this.#flow() }
  }

  /** What a window typed. After the shell exited, a key starts it again (and isn't typed). */
  input(bytes: Uint8Array) {
    if (!this.#pty) {
      if (!this.#killed) this.start()
      return
    }
    if (this.status.seen()) this.#options.onStatus()
    this.#pty.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }

  resize(cols: number, rows: number) {
    cols = Math.max(2, Math.min(1000, Math.floor(cols)))
    rows = Math.max(1, Math.min(500, Math.floor(rows)))
    if (cols === this.#size.cols && rows === this.#size.rows) return
    this.#size = { cols, rows }
    try { this.#pty?.resize(cols, rows) } catch { /* exiting */ }
  }

  /** Say something in the terminal, dim, on a line of its own. */
  note(text: string) {
    this.#print(Buffer.from(`\x1b[2m[${text}]\x1b[0m\r\n`))
  }

  /**
   * Stop the shell for good (its pane closed, its thread archived, the daemon stopping): SIGHUP, as a closed terminal
   * window sends. What its programs reported of resuming them stays the daemon's to keep or forget.
   */
  kill() {
    this.#killed = true
    this.#sweep(false)
    const pty = this.#pty
    this.#pty = undefined
    try { pty?.kill('SIGHUP') } catch { /* gone already */ }
    this.#readers.clear()
  }

  /** The shell printed `bytes`: kept, passed on, and read for reports (answering a program that asks about status). */
  #printed(bytes: Buffer) {
    if (bytes.includes(0x1b) || this.status.reading || this.#resume?.reading) {
      const text = bytes.toString('latin1')
      const { changed, asked } = this.status.read(text)
      if (changed) this.#options.onStatus()
      for (let i = 0; i < asked; i++) this.#pty?.write(REPLY)
      if (this.#resume?.read(text)) this.#resumed()
    }
    this.#print(bytes)
  }

  /** What would bring its programs back changed: said, and their owners watched while there are any. */
  #resumed() {
    const resume = this.#resume
    if (!resume) return
    this.#options.onResume?.(resume.resume())
    this.#sweep(resume.holding)
  }

  /** Watch for the owners of what was reported exiting (so what the user quit isn't brought back), or stop. */
  #sweep(on: boolean) {
    if (!on) { clearInterval(this.#sweeping); this.#sweeping = undefined; return }
    this.#sweeping ??= setInterval(() => {
      if (!this.#resume) this.#sweep(false)
      else if (this.#resume.sweep() || !this.#resume.holding) this.#resumed()
    }, SWEEP)
    this.#sweeping.unref?.()
  }

  #print(bytes: Buffer) {
    this.#chunks.push(bytes)
    this.#kept += bytes.length
    if (this.#kept > SCROLLBACK) this.#trim()
    for (const reader of this.#readers.keys()) this.#send(reader, bytes)
  }

  /** Down to the scrollback's size, from a line's start, so what's replayed starts cleanly. */
  #trim() {
    const all = Buffer.concat(this.#chunks)
    let from = all.length - SCROLLBACK
    const line = all.indexOf(0x0a, from)
    if (line >= 0 && line - from < 4096) from = line + 1
    const kept = all.subarray(from)
    this.#chunks = [Buffer.from(kept)]
    this.#kept = kept.length
  }

  #send(reader: Reader, bytes: Buffer) {
    this.#readers.set(reader, (this.#readers.get(reader) ?? 0) + bytes.length)
    this.#flow()
    reader.write(bytes).then(
      () => { if (this.#readers.has(reader)) { this.#readers.set(reader, this.#readers.get(reader)! - bytes.length); this.#flow() } },
      () => { this.#readers.delete(reader); this.#flow() },
    )
  }

  /** Pause the shell while a window is far behind; go on once every one has caught up. */
  #flow() {
    const behind = Math.max(0, ...this.#readers.values())
    if (!this.#paused && behind > HIGH) { this.#paused = true; this.#pty?.pause() }
    else if (this.#paused && behind < LOW) { this.#paused = false; this.#pty?.resume() }
  }
}

// The PTY host: one shell per terminal pane, run by the daemon so it outlives the window (PLAN §1, principle 2). Each
// keeps what it printed last (its scrollback), so a window that attaches again (a reload, another client, a browser)
// sees it, and passes on what it prints to every window attached. A slow window slows the shell, as a real terminal's
// screen does: past HIGH bytes unread by any, the PTY is paused until all are below LOW.
import { createRequire } from 'node:module'
import { RpcError } from '@superego/protocol'
import type { IPty } from '@lydell/node-pty'
import { ProgramStatus, REPLY } from './osc.ts'

/** How much of what a terminal printed is kept for windows that attach later. */
export const SCROLLBACK = 1024 * 1024
const HIGH = 1024 * 1024
const LOW = 256 * 1024

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

export type TerminalOptions = {
  /** The shell and its arguments, and where and with what it starts. */
  file: string
  args: string[]
  cwd: () => string
  env: () => Record<string, string>
  spawn: Spawn
  /** What its programs report (OSC 7501) changed. */
  onStatus(): void
  /** Its shell exited, saying `code`. */
  onExit(code: number): void
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

  constructor(options: TerminalOptions) {
    this.#options = options
  }

  get running() { return Boolean(this.#pty) }
  get pid() { return this.#pty?.pid }
  get size() { return { ...this.#size } }

  /** Start the shell, unless it's running. Throws an `RpcError` when it can't. */
  start() {
    if (this.#pty || this.#killed) return
    let pty: IPty
    try {
      pty = this.#options.spawn(this.#options.file, this.#options.args, { cwd: this.#options.cwd(), ...this.#size, env: this.#options.env() })
    } catch (error) {
      if (error instanceof RpcError) throw error
      throw new RpcError('unavailable', `Couldn't start ${this.#options.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.#pty = pty
    this.#paused = false
    pty.onData((text) => this.#printed(Buffer.from(text, 'utf8')))
    pty.onExit(({ exitCode, signal }) => {
      if (this.#pty !== pty) return
      this.#pty = undefined
      if (this.status.reset()) this.#options.onStatus()
      if (this.#killed) return
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

  /** Stop the shell for good (its pane closed, its thread archived): SIGHUP, as a closed terminal window sends. */
  kill() {
    this.#killed = true
    const pty = this.#pty
    this.#pty = undefined
    try { pty?.kill('SIGHUP') } catch { /* gone already */ }
    this.#readers.clear()
  }

  /** The shell printed `bytes`: kept, passed on, and read for status reports (answering a program that asks). */
  #printed(bytes: Buffer) {
    if (bytes.includes(0x1b) || this.status.reading) {
      const { changed, asked } = this.status.read(bytes.toString('latin1'))
      if (changed) this.#options.onStatus()
      for (let i = 0; i < asked; i++) this.#pty?.write(REPLY)
    }
    this.#print(bytes)
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

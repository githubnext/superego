// A process's output: the file it writes (`output.log`, which it appends to itself, so it goes on while no daemon runs),
// and what was rotated away to `output.log.1`. Positions are absolute: bytes of everything it ever wrote, counted from
// `base` (what rotation moved out of `output.log`), so a reader's `since` holds across rotations and restarts.
//
// Rotation is copy-then-truncate (the process keeps its file open, appending): what it writes between the copy and the
// truncate is lost, a few bytes at most.
import { appendFile, copyFile, open, rm, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'

/** The log rotates to `.1` past this, so a process keeps 8 MiB at most. */
export const ROTATE_AT = 4 * 1024 * 1024
/** At most this much is read at once, the newest part. */
export const READ_AT_MOST = 256 * 1024

const size = (path: string) => stat(path).then((s) => s.size, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return 0
  throw error
})

/** The bytes of `path` from `at` (to `upTo`, or its end). */
async function bytes(path: string, at: number, upTo?: number): Promise<Buffer> {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!file) return Buffer.alloc(0)
  try {
    const length = Math.max(0, (upTo ?? (await file.stat()).size) - at)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await file.read(buffer, 0, length, at)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/** How many bytes at the start are the middle of a character (UTF-8 continuation bytes). */
function partialStart(buffer: Buffer) {
  let n = 0
  while (n < buffer.length && n < 3 && (buffer[n]! & 0xc0) === 0x80) n++
  return n
}

/** How many bytes at the end are a character not yet whole. */
function partialEnd(buffer: Buffer) {
  for (let back = 1; back <= Math.min(3, buffer.length); back++) {
    const byte = buffer[buffer.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > back ? back : 0
  }
  return 0
}

/** A process's log in its folder: `output.log` and `output.log.1`, `base` bytes rotated away so far. */
export class OutputLog {
  readonly path: string
  readonly old: string
  base: number
  private readonly rotateAt: number
  constructor(dir: string, base = 0, rotateAt = ROTATE_AT) {
    this.path = join(dir, 'output.log')
    this.old = `${this.path}.1`
    this.base = base
    this.rotateAt = rotateAt
  }

  /** Where everything written so far ends. */
  async end() { return this.base + await size(this.path) }

  /** Where the oldest output kept begins. */
  async first() { return this.base - await size(this.old) }

  /** Rotate it if it has grown past its size: whether it did (`base` moved: keep it). */
  async rotate(): Promise<boolean> {
    const now = await size(this.path)
    if (now <= this.rotateAt) return false
    await copyFile(this.path, this.old)
    await truncate(this.path, 0)
    this.base += now
    return true
  }

  /** Add a line of its own (a run's start or end) to the output. */
  async note(text: string) { await appendFile(this.path, text) }

  /** Remove its files (it's removed). */
  async remove() { await Promise.all([rm(this.path, { force: true }), rm(this.old, { force: true })]) }

  /**
   * Its output from `since` (absolute), whole characters only: what's gone (rotated away twice) or more than `most` back
   * from the end isn't read (`from` says where it starts). `end` is where it stops: the next `since`.
   */
  async read(since: number, most = READ_AT_MOST): Promise<{ text: string; from: number; end: number; first: number }> {
    const current = await size(this.path)
    const oldSize = await size(this.old)
    const end = this.base + current
    const first = this.base - oldSize
    let from = Math.min(end, Math.max(since, first, end - most))
    const parts: Buffer[] = []
    if (from < this.base) parts.push(await bytes(this.old, from - first, oldSize))
    parts.push(await bytes(this.path, Math.max(0, from - this.base), current))
    let buffer = Buffer.concat(parts)
    // Started mid-character (a cut, not a `since` given back): skip to the next whole one.
    const skip = from === since ? 0 : partialStart(buffer)
    const keep = buffer.length - skip - partialEnd(buffer.subarray(skip))
    buffer = buffer.subarray(skip, skip + keep)
    from += skip
    return { text: buffer.toString('utf8'), from, end: from + buffer.length, first }
  }
}

// SGR, cursor and other CSI sequences, OSC (titles, links) and lone escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/** Text without terminal escapes. */
export const stripAnsi = (text: string) => text.replace(ANSI, '')

/** Plain lines as a terminal would leave them: escapes gone, and a line redrawn with `\r` only its last drawing. */
export function plainLines(text: string): string[] {
  return stripAnsi(text).split('\n').map((line) => {
    const parts = line.replace(/\r$/, '').split('\r')
    return parts[parts.length - 1]!
  })
}

/** The last `count` lines of `text`, plain; `grep`, only the lines it keeps. */
export function tail(text: string, count: number, grep?: (line: string) => boolean): string {
  let lines = plainLines(text)
  if (lines.at(-1) === '') lines.pop()
  if (grep) lines = lines.filter(grep)
  return lines.slice(-count).join('\n')
}

/** Text, or `/regex/flags`, as a test of output: a regex when it's written as one, else the text itself. */
export function matcher(pattern: string): (text: string) => boolean {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(pattern)
  if (regex) {
    const re = new RegExp(regex[1]!, regex[2]!.replace(/g/g, ''))
    return (text) => re.test(text)
  }
  return (text) => text.includes(pattern)
}

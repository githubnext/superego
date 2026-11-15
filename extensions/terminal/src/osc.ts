// OSC 7501, the Program Status Protocol, read from what a terminal prints: how Claude Code, Codex, pi and any program
// say they're working, done or blocked, in the same words Superego's threads use (PLAN §4, after Fut).
//
//   ESC ] 7501 ; state=<idle|working|done|blocked|error|clear> [:id=…] [:kind=…] [:app=…] [:title=<b64>] [:msg=<b64>] [:progress=…] (BEL | ESC \)
//   ESC ] 7501 ; ? (BEL | ESC \)      a program asking whether the terminal listens: answered with REPLY
//
// A report replaces its record (by id; none for the root); `clear` removes one (its id and what's under it), or all.
// The terminal's status is its most pressing record's.
import { rollup, type BlockedKind, type StatusState } from '@superego/protocol'
import type { TerminalStatus } from './shared.ts'

/** What this terminal answers a program asking: the states and kinds it understands. */
export const REPLY = '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

const START = '\x1b]7501;'
/** Longer than this unterminated, it's not a report: dropped. */
const LONGEST = 4096
const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error'])
const KINDS = new Set(['permission', 'question', 'auth'])

type Record = TerminalStatus & { id: string }

export class ProgramStatus {
  #records = new Map<string, Record>()
  #carry = ''

  /**
   * Read a chunk of output (as Latin-1, byte for byte; reports are ASCII). Returns whether the status changed, and how
   * many programs asked whether this terminal listens.
   */
  read(chunk: string): { changed: boolean; asked: number } {
    const text = this.#carry + chunk
    this.#carry = ''
    let changed = false
    let asked = 0
    let at = 0
    for (;;) {
      const start = text.indexOf(START, at)
      if (start < 0) {
        // A report may begin at the very end: keep what could be its start.
        for (let n = Math.min(START.length - 1, text.length); n > 0; n--) {
          if (START.startsWith(text.slice(-n))) { this.#carry = text.slice(-n); break }
        }
        break
      }
      const body = start + START.length
      const bel = text.indexOf('\x07', body)
      const st = text.indexOf('\x1b\\', body)
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st)
      if (end < 0) {
        if (text.length - start <= LONGEST) this.#carry = text.slice(start)
        break
      }
      const report = text.slice(body, end)
      if (report === '?' || report.startsWith('?:')) asked++
      else if (this.#apply(report)) changed = true
      at = end + (end === st ? 2 : 1)
    }
    return { changed, asked }
  }

  /** Whether a report began in what was read last and goes on in what comes next. */
  get reading() { return this.#carry.length > 0 }

  /** The program is gone (the shell exited): nothing it said holds. */
  reset(): boolean {
    const had = this.#records.size > 0
    this.#records.clear()
    this.#carry = ''
    return had
  }

  /** Someone typed in the terminal: what was done or failed has been seen. */
  seen(): boolean {
    let changed = false
    for (const [id, record] of this.#records) if (record.state === 'done' || record.state === 'error') { this.#records.delete(id); changed = true }
    return changed
  }

  /** The most pressing record's status, or nothing while no program has said anything. */
  status(): TerminalStatus | undefined {
    if (!this.#records.size) return undefined
    const top = rollup(this.#records.values()) as Record
    const { id: _, ...status } = top
    return status
  }

  #apply(report: string): boolean {
    const fields = new Map<string, string>()
    for (const part of report.split(':')) {
      const eq = part.indexOf('=')
      if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1))
    }
    const state = fields.get('state')
    const id = fields.get('id') ?? ''
    if (state === 'clear') {
      if (!fields.has('id')) { const had = this.#records.size > 0; this.#records.clear(); return had }
      let removed = false
      for (const key of [...this.#records.keys()]) if (key === id || key.startsWith(`${id}/`)) { this.#records.delete(key); removed = true }
      return removed
    }
    if (!state || !STATES.has(state)) return false
    const kind = fields.get('kind')
    const msg = decode(fields.get('msg')) ?? decode(fields.get('title'))
    const app = fields.get('app') ?? this.#records.get('')?.app
    const record: Record = {
      id, state: state as StatusState,
      ...(state === 'blocked' && kind && KINDS.has(kind) ? { kind: kind as BlockedKind } : state === 'blocked' ? { kind: 'question' as const } : {}),
      ...(msg ? { msg } : {}), ...(app ? { app } : {}),
    }
    const before = this.#records.get(id)
    this.#records.set(id, record)
    return JSON.stringify(before) !== JSON.stringify(record)
  }
}

/** A field's text: base64 (either alphabet, padded or not), as UTF-8. */
function decode(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = Buffer.from(value, 'base64').toString('utf8').trim()
  return text || undefined
}

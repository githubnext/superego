// OSC 7577, the Program Resume Protocol (rev 0.5): how a program in a terminal says what brings it back after the
// terminal ends (a daemon restart, a reboot), proven by a token only the programs started in that terminal know.
//
//   ESC ] 7577 ; pid=<owner>:time=<unix seconds>:argv=<b64>,<b64>…[:cwd=<b64>][:need=<keys>]:mac=<hex> (BEL | ESC \)
//   ESC ] 7577 ; pid=<owner>:time=<unix seconds>:clear=1:mac=<hex> (BEL | ESC \)
//
// `mac` is sha256(<the body before :mac=> ":" <token>). A report whose mac or time doesn't hold is ignored: whoever sent
// it can't be told from a file shown with `cat`. One that holds but is malformed is rejected: its owner's record goes, as
// what brings it back has changed. An accepted one is its owner's record (`clear=1` removes it), while its owner runs
// (and GRACE after, as a program may exit just before the terminal does). What's brought back is one record: an
// ancestor's before its descendant's, else the latest.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { processTable, type ProcessTable } from '@superego/daemon/sdk'
import { OscReader } from './osc.ts'

/** The variable a terminal's first process finds its token in: none, and programs don't report. */
export const TOKEN = 'OSC7577_TOKEN'
/** A terminal's token, new each time it starts: 32 characters of [A-Za-z0-9_-], 192 random bits. */
export const newToken = () => randomBytes(24).toString('base64url')

/** Longer than this (all of it, opener to terminator), a report is ignored. The spec's least: 2048. */
const LONGEST = 8192
/** More arguments than this, and a report is rejected. The spec's least: 64. */
const MOST_ARGS = 256
/** How far from now a report's time may be, in seconds. */
const WINDOW = 60
/** How long after its owner exited a record is still brought back, in ms. */
export const GRACE = 2000
/** The keys this terminal implements, for `need`. */
const KNOWN = new Set(['pid', 'time', 'mac', 'argv', 'cwd', 'clear', 'need'])

/** What brings a program back, as a terminal keeps it. */
export type Resume = {
  argv: string[]
  /** Where it said to resume it: gone by then, and it isn't. */
  cwd?: string
  /** Where it was when it reported (it didn't say): gone by then, and it's resumed in the pane's folder. */
  dir?: string
  /** It was the terminal's first process (no shell above it), so comes back as that. */
  first?: true
}

/** What a terminal asks of the machine about the processes in it: the daemon's process table, or a test's. */
export type Processes = ProcessTable

/** What OSC 7577 says to a terminal: a program's report verified, its owner, and what it asks. */
export type Report =
  | { outcome: 'ignored' }
  | { outcome: 'rejected'; pid: number; time: number }
  | { outcome: 'cleared'; pid: number; time: number }
  | { outcome: 'accepted'; pid: number; time: number; argv: string[]; cwd?: string }

const IGNORED = { outcome: 'ignored' } as const

/**
 * Read a report's body as the spec orders it: its mac (the last key) and its time first, failing either it's ignored;
 * then its owner (none usable: ignored too, there's no one's record to remove); then the rest, strictly, failing which
 * it's rejected. `now` in seconds. Whether it's earlier than the last report its owner made is the caller's to say.
 */
export function readReport(body: string, token: string, now: number): Report {
  const at = body.lastIndexOf(':mac=')
  if (at < 0) return IGNORED
  const mac = body.slice(at + ':mac='.length)
  if (!/^[0-9a-f]{64}$/.test(mac)) return IGNORED
  const prefix = body.slice(0, at)
  const want = createHash('sha256').update(Buffer.from(`${prefix}:`, 'latin1')).update(token).digest()
  if (!timingSafeEqual(want, Buffer.from(mac, 'hex'))) return IGNORED

  const pairs = prefix.split(':')
  const time = number(only(pairs, 'time'), Number.MAX_SAFE_INTEGER)
  if (time === undefined || Math.abs(now - time) > WINDOW) return IGNORED
  const pid = number(only(pairs, 'pid'), 0x7fffffff)
  if (pid === undefined) return IGNORED
  const rejected = { outcome: 'rejected', pid, time } as const

  const fields = new Map<string, string>()
  for (const pair of pairs) {
    const field = /^([a-z]+)=([A-Za-z0-9_.,+/=-]*)$/.exec(pair)
    if (!field || fields.has(field[1]!) || field[1] === 'mac') return rejected
    fields.set(field[1]!, field[2]!)
  }
  const need = fields.get('need')
  if (need !== undefined && need.split(',').some((key) => !KNOWN.has(key))) return rejected
  const argv = fields.get('argv')
  const clear = fields.get('clear')
  if ((argv === undefined) === (clear === undefined)) return rejected
  const folder = fields.get('cwd')
  const cwd = folder === undefined ? undefined : text(folder)
  if (folder !== undefined && !cwd?.startsWith('/')) return rejected
  if (clear !== undefined) return clear === '1' ? { outcome: 'cleared', pid, time } : rejected

  const words = argv!.split(',')
  if (words.length > MOST_ARGS) return rejected
  const args = words.map(text)
  const program = args[0]
  if (args.some((arg) => arg === undefined) || !program || program.startsWith('-') || (program.includes('/') && !program.startsWith('/'))) return rejected
  return { outcome: 'accepted', pid, time, argv: args as string[], ...(cwd !== undefined ? { cwd } : {}) }
}

/** The value of the one `key=` pair among `pairs`: none, or more than one, and there's none. */
function only(pairs: string[], key: string): string | undefined {
  const found = pairs.filter((pair) => pair.startsWith(`${key}=`))
  return found.length === 1 ? found[0]!.slice(key.length + 1) : undefined
}

/** A positive decimal up to `most`, as the protocol writes pids and times. */
function number(value: string | undefined, most: number): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined
  const n = Number(value)
  return n <= most ? n : undefined
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * A value's text: standard base64 (padding optional, but right if there), of UTF-8 without control characters.
 * Anything else, and there's none.
 */
function text(value: string): string | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  // The bits past the last byte are zero: one encoding for each text.
  if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return undefined
  let decoded: string
  try { decoded = UTF8.decode(bytes) } catch { return undefined /* not UTF-8: rejected, as the spec says */ }
  return /[\u0000-\u001f\u007f-\u009f]/.test(decoded) ? undefined : decoded
}

/** A command as the user is shown it: each word that isn't plain quoted, and what could mislead (controls, bidi overrides, odd spaces) escaped. */
export function shown(argv: string[]): string {
  const line = argv.map((word) => /^[\w./,:=+@%^-]+$/.test(word) ? word : `'${word
    .replace(/[\\']/g, '\\$&')
    .replace(/[\p{C}\p{Z}]/gu, (c) => c === ' ' ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`)}'`).join(' ')
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

type Record = Resume & {
  pid: number
  start: string
  /** Its ancestors up to the terminal's first process. */
  line: number[]
  /** In order accepted. */
  seq: number
  /** When it was found gone (ms). */
  gone?: number
}

/**
 * What the programs in one run of a terminal (one token) report of resuming them. `root` is the terminal's first
 * process: a report's owner must be it or one of its descendants.
 */
export class ProgramResume {
  #osc = new OscReader(7577, LONGEST)
  #records = new Map<number, Record>()
  /** The time of the last report accepted for each owner. */
  #times = new Map<number, number>()
  #seq = 0
  #token: string
  #root: number
  #processes: Processes
  #now: () => number

  constructor({ token, root, processes = processTable, now = Date.now }: { token: string; root: number; processes?: Processes; now?: () => number }) {
    this.#token = token
    this.#root = root
    this.#processes = processes
    this.#now = now
  }

  /** Read a chunk of output (as Latin-1, byte for byte). Returns whether what it would bring back changed. */
  read(chunk: string): boolean {
    const bodies = this.#osc.read(chunk)
    if (!bodies.length) return false
    const before = JSON.stringify(this.resume())
    for (const body of bodies) this.#apply(body)
    return JSON.stringify(this.resume()) !== before
  }

  /** Whether a report began in what was read last and goes on in what comes next. */
  get reading() { return this.#osc.reading }

  /** Whether it holds records, whose owners are to be watched (`sweep`). */
  get holding() { return this.#records.size > 0 }

  /** What it would bring back: its owner running, or gone only just. */
  resume(): Resume | undefined {
    const records = [...this.#records.values()]
    const top = records
      .filter((record) => !records.some((other) => other !== record && record.line.includes(other.pid)))
      .sort((a, b) => b.seq - a.seq)[0]
    if (!top) return undefined
    const { argv, cwd, dir, first } = top
    return { argv, ...(cwd !== undefined ? { cwd } : {}), ...(dir !== undefined ? { dir } : {}), ...(first ? { first } : {}) }
  }

  /** Drop the records whose owners have been gone longer than GRACE. Returns whether what it would bring back changed. */
  sweep(): boolean {
    const before = JSON.stringify(this.resume())
    const now = this.#now()
    for (const [pid, record] of this.#records) {
      if (this.#processes.info(pid)?.start === record.start) delete record.gone
      else if ((record.gone ??= now) < now - GRACE) this.#records.delete(pid)
    }
    return JSON.stringify(this.resume()) !== before
  }

  /** Its shell exited: everything in it is gone. Returns whether it held anything. */
  reset(): boolean {
    const had = this.#records.size > 0
    this.#records.clear()
    this.#times.clear()
    this.#osc.reset()
    return had
  }

  #apply(body: string) {
    if (body === '?') return
    const report = readReport(body, this.#token, Math.floor(this.#now() / 1000))
    if (report.outcome === 'ignored' || report.time < (this.#times.get(report.pid) ?? 0)) return
    const { pid } = report
    if (report.outcome === 'rejected') { this.#records.delete(pid); return }
    const running = this.#processes.info(pid)
    const line = running && this.#line(pid, running.ppid)
    // Its owner isn't running in this terminal: rejected too.
    if (!running || !line) { this.#records.delete(pid); return }
    this.#times.set(pid, report.time)
    if (report.outcome === 'cleared') { this.#records.delete(pid); return }
    const dir = report.cwd === undefined ? this.#processes.cwd(pid) : undefined
    this.#records.set(pid, {
      argv: report.argv, ...(report.cwd !== undefined ? { cwd: report.cwd } : {}), ...(dir !== undefined ? { dir } : {}),
      ...(pid === this.#root ? { first: true as const } : {}), pid, start: running.start, line, seq: ++this.#seq,
    })
  }

  /** The ancestors of `pid` up to the terminal's first process; none if it isn't one of its. */
  #line(pid: number, ppid: number): number[] | undefined {
    if (pid === this.#root) return []
    const line: number[] = []
    for (let parent: number | undefined = ppid; line.length < 64 && parent && parent > 1; parent = this.#processes.info(parent)?.ppid) {
      line.push(parent)
      if (parent === this.#root) return line
    }
    return undefined
  }
}

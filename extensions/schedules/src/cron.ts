// schedules: calendar times, as cron says them (five fields: minute, hour, day of month, month, day of week), in a
// timezone. "every weekday at 9" is `0 9 * * 1-5`. Pure: the next time after a given one, on the wall clock of `tz`
// (an IANA name), so a schedule made in Copenhagen keeps Copenhagen's 09:00 whatever the machine's zone says later.
//
// Fields take `*`, numbers, ranges (`1-5`), steps (`*/15`, `0-30/10`) and lists (`1,3,5`); months and days of the week
// their English names too (`mon-fri`, `jan`). Day of week 0 and 7 are Sunday. As cron has it, when both day fields are
// restricted a day matching either runs.

export class CronError extends Error {}

type Field = { min: number; max: number; names?: string[] }
const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
]
const WHAT = ['minute', 'hour', 'day of the month', 'month', 'day of the week']

/** A cron expression, read: each field's values, and whether its day fields are restricted. */
export type Cron = { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean }

function value(text: string, field: Field, what: string) {
  const named = field.names?.indexOf(text.toLowerCase().slice(0, 3)) ?? -1
  const n = named >= 0 && /^[a-z]+$/i.test(text) ? named + (field.min === 1 ? 1 : 0) : /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isInteger(n) || n < field.min || n > field.max) throw new CronError(`"${text}" isn't a valid ${what} (${field.min}–${field.max}).`)
  return n
}

function parseField(text: string, field: Field, what: string): number[] {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new CronError(`"${part}" isn't a ${what}.`)
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) throw new CronError(`A step of ${m[2]} for the ${what} is no step.`)
    let from: number, to: number
    if (m[1] === '*') { from = field.min; to = field.max }
    else if (m[1]!.includes('-')) {
      const [a, b] = m[1]!.split('-')
      from = value(a!, field, what); to = value(b!, field, what)
      if (to < from) throw new CronError(`${m[1]}: the ${what} range runs backwards.`)
    } else { from = value(m[1]!, field, what); to = m[2] ? field.max : from }
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/** Read a cron expression; throws `CronError` saying what's wrong. */
export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new CronError(`"${expression}" isn't cron: it takes five fields (minute hour day month weekday).`)
  const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, FIELDS[i]!, WHAT[i]!))
  return {
    minutes: minutes!, hours: hours!, days: new Set(days), months: new Set(months), weekdays: new Set(weekdays!.map((d) => d % 7)),
    anyDay: fields[2] === '*', anyWeekday: fields[4] === '*',
  }
}

// ── Wall clocks in a zone ────────────────────────────────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.DateTimeFormat>()
const format = (tz: string) => {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(tz, f)
  }
  return f
}

/** Whether `tz` is a timezone this machine knows. */
export function knownZone(tz: string) {
  try { format(tz); return true } catch { return false }
}

/** `at` on the wall clock of `tz`: [year, month (1–12), day, hour, minute]. */
export function wall(at: number, tz: string): [number, number, number, number, number] {
  const parts = Object.fromEntries(format(tz).formatToParts(at).map((p) => [p.type, p.value]))
  return [Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour) % 24, Number(parts.minute)]
}

/** How far `tz` is ahead of UTC at `at`, in ms. */
const offset = (at: number, tz: string) => {
  const [y, mo, d, h, mi] = wall(at, tz)
  return Date.UTC(y, mo - 1, d, h, mi) - Math.floor(at / 60_000) * 60_000
}

/** The time it is when `tz`'s wall clock says this (a time a clock change skips is read as after it). */
export function fromWall(y: number, mo: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const first = guess - offset(guess, tz)
  const second = guess - offset(first, tz)
  return first === second ? first : Math.max(first, second)
}

/** The first time after `after` that `cron` names, on `tz`'s wall clock; undefined if none comes within eight years. */
export function nextCron(cron: Cron, tz: string, after: number): number | undefined {
  const [y, mo, d] = wall(after, tz)
  for (let i = 0; i < 366 * 8; i++) {
    const day = new Date(Date.UTC(y, mo - 1, d + i))
    const [dy, dmo, dd, dow] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()]
    if (!cron.months.has(dmo)) continue
    const byDay = cron.days.has(dd)
    const byWeekday = cron.weekdays.has(dow)
    const ok = cron.anyDay && cron.anyWeekday ? true : cron.anyDay ? byWeekday : cron.anyWeekday ? byDay : byDay || byWeekday
    if (!ok) continue
    for (const h of cron.hours) {
      for (const mi of cron.minutes) {
        const at = fromWall(dy, dmo, dd, h, mi, tz)
        if (at > after) return at
      }
    }
  }
  return undefined
}

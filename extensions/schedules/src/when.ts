// schedules: the user's words for a time, read in this machine's timezone, and times said back in words. Pure: `now`
// is given, so tests (and the daemon's clock) decide what time it is.
//
// Understood: "in 30m", "in 1h 30m", "in an hour", "at 9", "at 9:30", "9am", "14:30", "noon", "tomorrow 9am",
// "tomorrow" (09:00), "friday 17:00", "next monday at 9", "2026-05-02T09:00", "2026-05-02 09:00", "2026-05-02" (09:00);
// and repeating: "every 30m", "every 2 hours", "every hour". Calendar repeats ("every weekday at 9", cron) aren't yet.
import type { When } from './shared.ts'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** What `when` takes, for an error that lists it. */
export const FORMS = '"in 30m", "in 2 hours", "at 9:30", "9am", "tomorrow 9:00", "friday 17:00", "2026-05-02T09:00", "every 30m", "every 2 hours"'

export class WhenError extends Error {}

const UNITS: [RegExp, number][] = [
  [/^(s|secs?|seconds?)$/, 1000],
  [/^(m|mins?|minutes?)$/, MINUTE],
  [/^(h|hrs?|hours?)$/, HOUR],
  [/^(d|days?)$/, DAY],
  [/^(w|wks?|weeks?)$/, 7 * DAY],
]
const unit = (word: string) => UNITS.find(([re]) => re.test(word))?.[1]

/** A length of time ("30m", "1h 30m", "an hour", "1.5 hours", "half an hour"), in ms; undefined if it isn't one. */
export function parseDuration(text: string): number | undefined {
  let rest = text.trim().toLowerCase().replace(/\band\b|,/g, ' ').replace(/\bhalf an? hour\b/, '30 minutes').replace(/\ban? (?=[a-z])/g, '1 ')
  if (!rest) return undefined
  let total = 0
  while (rest) {
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*/.exec(rest)
    const ms = m && unit(m[2]!)
    if (!m || !ms) return undefined
    total += Number(m[1]) * ms
    rest = rest.slice(m[0].length)
  }
  return Math.round(total)
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const dayIndex = (word: string) => DAYS.findIndex((d) => d === word || (word.length >= 3 && d.startsWith(word)))

/** A clock time ("9", "9:30", "9am", "9.30pm", "14:30", "noon", "midnight") as [hours, minutes]; undefined if it isn't one. */
export function parseClock(text: string): [number, number] | undefined {
  const t = text.trim().toLowerCase().replace(/^at\s+/, '')
  if (t === 'noon' || t === 'midday') return [12, 0]
  if (t === 'midnight') return [0, 0]
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t)
  if (!m) return undefined
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const half = m[3]?.[0]
  if (half) {
    if (h < 1 || h > 12) return undefined
    h = h % 12 + (half === 'p' ? 12 : 0)
  }
  if (h > 23 || min > 59) return undefined
  return [h, min]
}

/** That day (`base`'s, local) at `h:m`, local. */
const atClock = (base: number, [h, m]: [number, number]) => { const d = new Date(base); d.setHours(h, m, 0, 0); return d.getTime() }
const plusDays = (base: number, days: number) => { const d = new Date(base); d.setDate(d.getDate() + days); return d.getTime() }

/** A time once, from the user's words; throws `WhenError` saying what's understood. */
export function parseAt(text: string, now: number): number {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  // ISO: a date, with a time or not (09:00), local unless it says its zone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?(z|[+-]\d{2}:?\d{2})?)?$/.exec(t)
  if (iso) {
    const at = iso[7]
      ? Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] ?? '00'}${iso[7].toUpperCase()}`)
      : new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), Number(iso[4] ?? 9), Number(iso[5] ?? 0), Number(iso[6] ?? 0)).getTime()
    if (Number.isNaN(at)) throw new WhenError(`"${text}" isn't a date I can read.`)
    if (at <= now) throw new WhenError(`${text} has passed.`)
    return at
  }
  const relative = /^in (.+)$/.exec(t)
  if (relative) {
    const ms = parseDuration(relative[1]!)
    if (ms === undefined) throw new WhenError(`"${text}": I can't read "${relative[1]}" as a length of time.`)
    if (ms < 1000) throw new WhenError(`"${text}" is now: give a time ahead.`)
    return now + ms
  }
  // A day ("today", "tomorrow", a weekday, "next friday"), then a clock time or not.
  const day = /^(?:on )?(today|tonight|tomorrow|(?:next )?[a-z]+)\b(?: at)?\s*(.*)$/.exec(t)
  if (day && !parseClock(t)) {
    const word = day[1]!.replace(/^next /, '')
    const clock = day[2] ? parseClock(day[2]) : [9, 0] as [number, number]
    if (!clock) throw new WhenError(`"${text}": I can't read "${day[2]}" as a time of day.`)
    if (word === 'today' || word === 'tonight') {
      const at = atClock(now, day[2] ? clock : word === 'tonight' ? [20, 0] : clock)
      if (at <= now) throw new WhenError(`${text} has passed.`)
      return at
    }
    if (word === 'tomorrow') return atClock(plusDays(now, 1), clock)
    const index = dayIndex(word)
    if (index < 0) throw new WhenError(`"${text}" isn't a time I understand. Try ${FORMS}.`)
    const today = new Date(now).getDay()
    let ahead = (index - today + 7) % 7
    if (ahead === 0 && (day[1]!.startsWith('next ') || atClock(now, clock) <= now)) ahead = 7
    return atClock(plusDays(now, ahead), clock)
  }
  const clock = parseClock(t)
  if (clock) {
    const at = atClock(now, clock)
    return at > now ? at : atClock(plusDays(now, 1), clock)
  }
  throw new WhenError(`"${text}" isn't a time I understand. Try ${FORMS}.`)
}

/** When a schedule fires, from the user's words: once, or every so often from now. Throws `WhenError`. */
export function parseWhen(text: string, now: number): When {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const every = /^every (.+)$/.exec(t)
  if (every) {
    const what = every[1]!
    const ms = parseDuration(/^\d/.test(what) ? what : `1 ${what}`)
    if (ms === undefined) {
      throw new WhenError(`"${text}": repeating on the calendar ("every weekday at 9", cron) isn't supported yet. ` +
        `Use an interval ("every 30m", "every 24 hours"), or schedule the next one once ("tomorrow 9:00").`)
    }
    return { every: ms, anchor: now }
  }
  if (/^(\S+ ){4}\S+$/.test(t) && /^[\d*/,-]+$/.test(t.replace(/ /g, ''))) {
    throw new WhenError(`"${text}": cron isn't supported yet. Use an interval ("every 30m") or a time ("tomorrow 9:00").`)
  }
  return { at: parseAt(t, now) }
}

// ── Said back ─────────────────────────────────────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
/** "14:30", local. */
export const clockTime = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

const startOfDay = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime() }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The day of `at` as seen from `now`: "today", "tomorrow", "Tue" (this week), "Tue 7 May" (further). */
export function dayWord(at: number, now: number) {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  const d = new Date(at)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 1 && days < 7) return WEEKDAYS[d.getDay()]!
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** A length of time, short: "45s", "12m", "2h", "1h 30m", "3d". */
export function shortDuration(ms: number) {
  const minutes = Math.round(ms / MINUTE)
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.round(ms / DAY)
  return `${days}d`
}

/** "in 12m", "in 2h"; "now" when it's within the minute; "12m ago" when past. */
export function relative(at: number, now: number) {
  const ms = at - now
  if (Math.abs(ms) < 30_000) return 'now'
  return ms > 0 ? `in ${shortDuration(ms)}` : `${shortDuration(-ms)} ago`
}

/** A time for the agent to check: "today 14:30 (in 30m)", "Tue 7 May 09:00 (in 6d)". */
export const localWords = (at: number, now: number) => `${dayWord(at, now)} ${clockTime(at)} (${relative(at, now)})`

/** A time for the user, short: "14:30" today, "tomorrow 09:00", "Tue 09:00". */
export const shortWhen = (at: number, now: number) => {
  const day = dayWord(at, now)
  return day === 'today' ? clockTime(at) : `${day} ${clockTime(at)}`
}

/** "every 30 min", "every 2 h", "every 1 h 30 min", "every day". */
export function everyWords(ms: number) {
  if (ms % DAY === 0) return ms === DAY ? 'every day' : `every ${ms / DAY} days`
  const minutes = Math.round(ms / MINUTE)
  if (minutes < 60) return minutes === 1 ? 'every minute' : `every ${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `every ${h} h ${m} min` : h === 1 ? 'every hour' : `every ${h} h`
}

/** This machine's timezone (an IANA name), for the agent. */
export const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

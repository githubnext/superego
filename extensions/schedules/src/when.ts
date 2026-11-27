// schedules: the user's words for a time, read in this machine's timezone, and times said back in words. Pure: `now`
// is given, so tests (and the daemon's clock) decide what time it is.
//
// Understood: "in 30m", "in 1h 30m", "in an hour", "at 9", "at 9:30", "9am", "14:30", "noon", "tomorrow 9am",
// "tomorrow" (09:00), "friday 17:00", "next monday at 9", "2026-05-02T09:00", "2026-05-02 09:00", "2026-05-02" (09:00);
// repeating: "every 30m", "every 2 hours", "every hour"; and on the calendar: "every weekday at 9", "every monday
// 10:00", "every mon and thu at 9am", "every day at 9", "weekdays at 9", or cron ("0 9 * * 1-5"), in the machine's
// timezone as it was when made (cron.ts).
import { CronError, nextCron, parseCron } from './cron.ts'
import type { When } from './shared.ts'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** What `when` takes, for an error that lists it. */
export const FORMS = '"in 30m", "in 2 hours", "at 9:30", "9am", "tomorrow 9:00", "friday 17:00", "2026-05-02T09:00", "every 30m", "every 2 hours", "every weekday at 9", "every monday 10:00", or cron ("0 9 * * 1-5")'

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

/** Days of the week in words ("weekday", "monday and thursday", "weekends"), as cron's field; undefined if they aren't. */
function weekdaysOf(text: string): string | undefined {
  const t = text.trim().replace(/^on /, '')
  if (/^(day|days)$/.test(t)) return '*'
  if (/^week ?days?$/.test(t)) return '1-5'
  if (/^weekends?( days?)?$/.test(t)) return '0,6'
  const words = t.split(/\s*(?:,|&|\band\b)\s*|\s+/).filter(Boolean)
  if (!words.length) return undefined
  const days = words.map((w) => dayIndex(w.replace(/s$/, '')))
  if (days.some((d) => d < 0)) return undefined
  return [...new Set(days)].sort((a, b) => a - b).join(',')
}

/** "weekday at 9", "monday 10:00", "mon and thu", read as cron; undefined if it isn't a calendar repeat. */
function calendar(what: string): string | undefined {
  const words = what.split(' ')
  // A clock time at the end (one word, or two: "9 am"), "at" before it; none: 09:00.
  for (const take of [2, 1, 0]) {
    if (take > words.length - 1 && take) continue
    const clock = take ? parseClock(words.slice(-take).join(' ')) : [9, 0] as [number, number]
    if (!clock) continue
    const days = weekdaysOf(words.slice(0, words.length - take).join(' ').replace(/\s+at$/, ''))
    if (days === undefined || (days === '*' && !take)) continue
    return `${clock[1]} ${clock[0]} * * ${days}`
  }
  return undefined
}

// Five fields that look like cron ("0 9 * * 1-5", "*/15 * * * *"), not words that happen to be five.
const CRON_FIELD = /^(?:[\d*][\d*/,-]*|[a-z]{3}(?:-[a-z]{3})?(?:,[a-z]{3})*)$/
const cronLike = (t: string) => {
  const fields = t.split(' ')
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f)) && fields.filter((f) => /^[\d*]/.test(f)).length >= 3
}

/** When a schedule fires, from the user's words: once, every so often from now, or on the calendar. Throws `WhenError`. */
export function parseWhen(text: string, now: number, tz = timezone()): When {
  let t = text.trim().toLowerCase().replace(/\s+/g, ' ')
  t = t.replace(/^daily\b/, 'every day').replace(/^(?:on )?(weekdays|weekends)\b/, 'every $1').replace(/^cron /, '')
  if (cronLike(t)) {
    try { parseCron(t) } catch (error) {
      if (error instanceof CronError) throw new WhenError(`"${text}": ${error.message}`)
      throw error
    }
    return { cron: t, tz }
  }
  const every = /^every (.+)$/.exec(t)
  if (every) {
    const what = every[1]!
    const ms = parseDuration(/^\d/.test(what) ? what : `1 ${what}`)
    if (ms !== undefined) return { every: ms, anchor: now }
    const cron = calendar(what)
    if (cron) return { cron, tz }
    throw new WhenError(`"${text}" isn't a repeat I understand. Try "every 30m", "every 2 hours", "every weekday at 9", "every monday 10:00", or cron ("0 9 * * 1-5").`)
  }
  return { at: parseAt(t, now) }
}

/** Whether it repeats (every so often, or on the calendar), not once. */
export const repeats = (when: When): when is Exclude<When, { at: number }> => !('at' in when)

/** Its next run after `after`: from when the last went (every so often), or the calendar's next; none for a one-shot. */
export function nextAfter(when: When, after: number): number | null {
  if ('at' in when) return null
  if ('every' in when) return after + when.every
  return nextCron(parseCron(when.cron), when.tz, after) ?? null
}

/** Its first run, made at `now`. */
export const firstRun = (when: When, now: number): number | null => 'at' in when ? when.at : 'every' in when ? when.anchor + when.every : nextAfter(when, now)

/** How many runs came due after `from`, up to `to` (`cap` at most). */
export function runsBetween(when: When, from: number, to: number, cap = 1000): number {
  if ('at' in when || to <= from) return 0
  if ('every' in when) return Math.min(cap, Math.floor((to - from) / when.every))
  let count = 0
  for (let at = nextAfter(when, from); at !== null && at <= to && count < cap; at = nextAfter(when, at)) count++
  return count
}

/** The shortest time between its runs, from `now` on (over its next few dozen, for the calendar's). */
export function shortestGap(when: When, now: number): number | undefined {
  if ('at' in when) return undefined
  if ('every' in when) return when.every
  let shortest: number | undefined
  let at = nextAfter(when, now)
  for (let i = 0; i < 60 && at !== null; i++) {
    const next = nextAfter(when, at)
    if (next === null) break
    shortest = Math.min(shortest ?? Infinity, next - at)
    at = next
  }
  return shortest
}

/**
 * What a user said for a schedule, in one go (`/schedule in 30m check the deploy`, `/schedule remind me tomorrow to
 * call Mia`): its time, at the start or the end, and the rest its message; "remind me" or "ping me" makes it a reminder
 * (notify). Undefined when no time is found.
 */
export function splitSaid(text: string, now: number): { when: string; message: string; action?: 'notify' } | undefined {
  let rest = text.trim().replace(/\s+/g, ' ')
  const remind = /^(?:remind|ping|nudge|tell) me\b\s*/i.exec(rest)
  if (remind) rest = rest.slice(remind[0].length)
  const words = rest.split(' ').filter(Boolean)
  const reads = (said: string) => { try { parseWhen(said, now); return true } catch { return false } }
  const tidy = (message: string) => {
    const m = remind ? message.replace(/^(?:to|about|that)\s+/i, '') : message
    return m.replace(/^[,:;-]\s*/, '').replace(/\s*[,:;-]$/, '').trim()
  }
  // The longest time at the start, else at the end, that leaves a message.
  for (let n = words.length - 1; n >= 1; n--) {
    const when = words.slice(0, n).join(' ')
    if (reads(when) && tidy(words.slice(n).join(' '))) return { when, message: capital(tidy(words.slice(n).join(' '))), ...(remind ? { action: 'notify' as const } : {}) }
  }
  for (let n = 1; n < words.length; n++) {
    const when = words.slice(n).join(' ').replace(/^(?:at|on)\s+(?=\S+\s)/i, (m) => /^at/i.test(m) ? m : '')
    if (reads(when) && tidy(words.slice(0, n).join(' '))) return { when, message: capital(tidy(words.slice(0, n).join(' '))), ...(remind ? { action: 'notify' as const } : {}) }
  }
  return undefined
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A calendar repeat in words, as it was said: "every weekday at 09:00", "every Mon, Thu at 10:00"; cron else. */
export function cronWords(cron: string) {
  const m = /^(\d+) (\d+) \* \* (\S+)$/.exec(cron)
  if (!m) return `cron ${cron}`
  const at = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`
  const days = m[3]!
  if (days === '*') return `every day at ${at}`
  if (days === '1-5') return `every weekday at ${at}`
  if (days === '0,6') return `weekends at ${at}`
  if (!/^\d(,\d)*$/.test(days)) return `cron ${cron}`
  const list = days.split(',').map((d) => DAY_NAMES[Number(d) % 7]!)
  return list.length === 1 ? `every ${list[0]} at ${at}` : `${list.join(', ')} at ${at}`
}

/** How a schedule repeats, or doesn't, in words: "every 30 min", "every weekday at 09:00", "once". */
export const howWords = (when: When) => 'every' in when ? everyWords(when.every) : 'cron' in when ? cronWords(when.cron) : 'once'

// The user's words for a time, read in this machine's timezone, and said back.
import { expect, it } from 'vitest'
import { clockTime, cronWords, dayWord, everyWords, firstRun, HOUR, localWords, MINUTE, nextAfter, parseAt, parseDuration, parseWhen, relative, runsBetween, shortestGap, splitSaid, WhenError } from '../src/when.ts'
import { fromWall, nextCron, parseCron } from '../src/cron.ts'

// Tuesday 5 May 2026, 14:00 local.
const NOW = new Date(2026, 4, 5, 14, 0).getTime()
const local = (d: number, h: number, m = 0) => new Date(2026, 4, d, h, m).getTime()

it('reads lengths of time', () => {
  expect(parseDuration('30m')).toBe(30 * MINUTE)
  expect(parseDuration('1h 30m')).toBe(90 * MINUTE)
  expect(parseDuration('1h30m')).toBe(90 * MINUTE)
  expect(parseDuration('2 hours and 15 minutes')).toBe(135 * MINUTE)
  expect(parseDuration('an hour')).toBe(HOUR)
  expect(parseDuration('half an hour')).toBe(30 * MINUTE)
  expect(parseDuration('1.5 hours')).toBe(90 * MINUTE)
  expect(parseDuration('soon')).toBeUndefined()
})

it('reads a time once, ahead of now', () => {
  expect(parseAt('in 30m', NOW)).toBe(NOW + 30 * MINUTE)
  expect(parseAt('at 15:30', NOW)).toBe(local(5, 15, 30))
  expect(parseAt('9am', NOW)).toBe(local(6, 9))           // passed today: tomorrow
  expect(parseAt('9:30pm', NOW)).toBe(local(5, 21, 30))
  expect(parseAt('noon', NOW)).toBe(local(6, 12))
  expect(parseAt('tomorrow', NOW)).toBe(local(6, 9))
  expect(parseAt('tomorrow at 7:15', NOW)).toBe(local(6, 7, 15))
  expect(parseAt('friday 17:00', NOW)).toBe(local(8, 17))
  expect(parseAt('tuesday 9am', NOW)).toBe(local(12, 9))   // today's has passed: next week's
  expect(parseAt('tuesday 16:00', NOW)).toBe(local(5, 16)) // today's is ahead
  expect(parseAt('next tuesday 16:00', NOW)).toBe(local(12, 16))
  expect(parseAt('today 18:00', NOW)).toBe(local(5, 18))
  expect(parseAt('2026-05-07T09:00', NOW)).toBe(local(7, 9))
  expect(parseAt('2026-05-07', NOW)).toBe(local(7, 9))
  expect(parseAt('2026-05-07T09:00Z', NOW)).toBe(Date.UTC(2026, 4, 7, 9))
})

it('says what it can’t read, and what has passed', () => {
  expect(() => parseAt('whenever', NOW)).toThrow(WhenError)
  expect(() => parseAt('whenever', NOW)).toThrow(/in 30m/)
  expect(() => parseAt('today 9:00', NOW)).toThrow(/has passed/)
  expect(() => parseAt('2026-01-01', NOW)).toThrow(/has passed/)
  expect(() => parseAt('in a while', NOW)).toThrow(/length of time/)
})

it('reads repeating as an interval from now, or on the calendar in a zone', () => {
  const tz = 'Europe/Copenhagen'
  expect(parseWhen('every 30m', NOW)).toEqual({ every: 30 * MINUTE, anchor: NOW })
  expect(parseWhen('every hour', NOW)).toEqual({ every: HOUR, anchor: NOW })
  expect(parseWhen('Every 2 Hours', NOW)).toEqual({ every: 2 * HOUR, anchor: NOW })
  expect(parseWhen('in 1h', NOW)).toEqual({ at: NOW + HOUR })
  expect(parseWhen('every weekday at 9', NOW, tz)).toEqual({ cron: '0 9 * * 1-5', tz })
  expect(parseWhen('every monday 10:00', NOW, tz)).toEqual({ cron: '0 10 * * 1', tz })
  expect(parseWhen('every mon and thu at 9:30am', NOW, tz)).toEqual({ cron: '30 9 * * 1,4', tz })
  expect(parseWhen('every friday', NOW, tz)).toEqual({ cron: '0 9 * * 5', tz })
  expect(parseWhen('every day at 18:00', NOW, tz)).toEqual({ cron: '0 18 * * *', tz })
  expect(parseWhen('weekdays at 8', NOW, tz)).toEqual({ cron: '0 8 * * 1-5', tz })
  expect(parseWhen('every weekend at noon', NOW, tz)).toEqual({ cron: '0 12 * * 0,6', tz })
  expect(parseWhen('0 9 * * 1-5', NOW, tz)).toEqual({ cron: '0 9 * * 1-5', tz })
  expect(parseWhen('*/15 9-17 * * mon-fri', NOW, tz)).toEqual({ cron: '*/15 9-17 * * mon-fri', tz })
  expect(parseWhen('every day', NOW)).toEqual({ every: 24 * HOUR, anchor: NOW })
  expect(() => parseWhen('every blue moon', NOW)).toThrow(/every weekday at 9/)
  expect(() => parseWhen('0 25 * * *', NOW)).toThrow(/isn't a valid hour/)
  // Five words aren't cron.
  expect(parseWhen('next friday at 9 am', NOW)).toEqual({ at: local(8, 9) })
})

it('finds the calendar’s next runs on the zone’s wall clock, across a clock change', () => {
  const tz = 'Europe/Copenhagen'
  const weekdays = parseCron('0 9 * * 1-5')
  // Fri 27 Mar 2026 10:00 there: next is Mon 30 Mar 09:00, after the clocks went forward (CEST, UTC+2).
  const friday = fromWall(2026, 3, 27, 10, 0, tz)
  expect(friday).toBe(Date.UTC(2026, 2, 27, 9, 0))
  expect(nextCron(weekdays, tz, friday)).toBe(Date.UTC(2026, 2, 30, 7, 0))
  expect(nextCron(parseCron('30 8 1 * *'), 'America/New_York', Date.UTC(2026, 0, 15))).toBe(Date.UTC(2026, 1, 1, 13, 30))
  // Both day fields: either.
  expect(nextCron(parseCron('0 0 13 * 5'), 'UTC', Date.UTC(2026, 4, 5))).toBe(Date.UTC(2026, 4, 8))
  const when = { cron: '0 9 * * 1-5', tz }
  expect(nextAfter(when, friday)).toBe(Date.UTC(2026, 2, 30, 7, 0))
  expect(firstRun(when, friday)).toBe(Date.UTC(2026, 2, 30, 7, 0))
  // From Friday 10:00 to the next Wednesday noon: Mon, Tue, Wed at 09:00.
  expect(runsBetween(when, friday, fromWall(2026, 4, 1, 12, 0, tz))).toBe(3)
  expect(shortestGap(when, friday)).toBe(24 * HOUR)
  expect(shortestGap({ cron: '*/5 * * * *', tz }, friday)).toBe(5 * MINUTE)
  expect(cronWords('0 9 * * 1-5')).toBe('every weekday at 09:00')
  expect(cronWords('30 10 * * 1')).toBe('every Mon at 10:30')
  expect(cronWords('0 9 * * 1,4')).toBe('Mon, Thu at 09:00')
  expect(cronWords('*/15 * * * *')).toBe('cron */15 * * * *')
})

it('splits what was said for a schedule into its time and its message; "remind me" makes it a reminder', () => {
  expect(splitSaid('in 30m check the deploy', NOW)).toEqual({ when: 'in 30m', message: 'Check the deploy' })
  expect(splitSaid('every weekday at 9 look at the error rate', NOW)).toEqual({ when: 'every weekday at 9', message: 'Look at the error rate' })
  expect(splitSaid('remind me tomorrow at 9 to review Mia’s PR', NOW)).toEqual({ when: 'tomorrow at 9', message: 'Review Mia’s PR', action: 'notify' })
  expect(splitSaid('remind me to stretch in 1h', NOW)).toEqual({ when: 'in 1h', message: 'Stretch', action: 'notify' })
  expect(splitSaid('check CI every 30m', NOW)).toEqual({ when: 'every 30m', message: 'Check CI' })
  expect(splitSaid('tomorrow check the deploy', NOW)).toEqual({ when: 'tomorrow', message: 'Check the deploy' })
  expect(splitSaid('check the deploy sometime', NOW)).toBeUndefined()
  expect(splitSaid('in 30m', NOW)).toBeUndefined()
})

it('says times back in words', () => {
  expect(clockTime(local(5, 9, 5))).toBe('09:05')
  expect(dayWord(local(5, 20), NOW)).toBe('today')
  expect(dayWord(local(6, 1), NOW)).toBe('tomorrow')
  expect(dayWord(local(8, 1), NOW)).toBe('Fri')
  expect(dayWord(local(14, 1), NOW)).toBe('Thu 14 May')
  expect(relative(NOW + 12 * MINUTE, NOW)).toBe('in 12m')
  expect(relative(NOW + 90 * MINUTE, NOW)).toBe('in 1h 30m')
  expect(localWords(NOW + 30 * MINUTE, NOW)).toBe('today 14:30 (in 30m)')
  expect(everyWords(30 * MINUTE)).toBe('every 30 min')
  expect(everyWords(HOUR)).toBe('every hour')
  expect(everyWords(2 * HOUR)).toBe('every 2 h')
  expect(everyWords(90 * MINUTE)).toBe('every 1 h 30 min')
  expect(everyWords(24 * HOUR)).toBe('every day')
})

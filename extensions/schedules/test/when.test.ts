// The user's words for a time, read in this machine's timezone, and said back.
import { expect, it } from 'vitest'
import { clockTime, dayWord, everyWords, HOUR, localWords, MINUTE, parseAt, parseDuration, parseWhen, relative, WhenError } from '../src/when.ts'

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

it('reads repeating as an interval from now; calendar repeats and cron say they come later', () => {
  expect(parseWhen('every 30m', NOW)).toEqual({ every: 30 * MINUTE, anchor: NOW })
  expect(parseWhen('every hour', NOW)).toEqual({ every: HOUR, anchor: NOW })
  expect(parseWhen('Every 2 Hours', NOW)).toEqual({ every: 2 * HOUR, anchor: NOW })
  expect(parseWhen('in 1h', NOW)).toEqual({ at: NOW + HOUR })
  expect(() => parseWhen('every weekday at 9', NOW)).toThrow(/isn't supported yet/)
  expect(() => parseWhen('0 9 * * 1-5', NOW)).toThrow(/cron/)
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

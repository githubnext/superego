// OSC 7501 as a terminal's output carries it: split anywhere, ended by BEL or ST, asked about, cleared, and seen.
import { expect, it } from 'vitest'
import { ProgramStatus } from '../src/osc.ts'

const b64 = (text: string) => Buffer.from(text).toString('base64url')

it('reads reports split across chunks, by either terminator, and answers how many asked', () => {
  const status = new ProgramStatus()
  const report = `before\x1b]7501;state=working:app=pi:title=${b64('Building')}\x07after\x1b]7501;?\x1b\\`
  let changed = false
  let asked = 0
  for (let at = 0; at < report.length; at += 3) {
    const read = status.read(report.slice(at, at + 3))
    changed ||= read.changed
    asked += read.asked
  }
  expect(changed).toBe(true)
  expect(asked).toBe(1)
  expect(status.status()).toEqual({ state: 'working', app: 'pi', msg: 'Building' })
})

it('shows the most pressing record, clears one by id or all, and forgets what was done once seen', () => {
  const status = new ProgramStatus()
  status.read(`\x1b]7501;state=working\x07\x1b]7501;state=blocked:id=t1:kind=permission:msg=${b64('Apply?')}\x1b\\`)
  expect(status.status()).toEqual({ state: 'blocked', kind: 'permission', msg: 'Apply?' })
  expect(status.read('\x1b]7501;state=clear:id=t1\x07').changed).toBe(true)
  expect(status.status()).toEqual({ state: 'working' })
  status.read('\x1b]7501;state=done:id=t2\x07')
  expect(status.status()?.state).toBe('done')
  expect(status.seen()).toBe(true)
  expect(status.status()).toEqual({ state: 'working' })
  status.read('\x1b]7501;state=clear\x07')
  expect(status.status()).toBeUndefined()
  // Not a report: an unknown state, or something else entirely.
  expect(status.read('\x1b]7501;state=dancing\x07\x1b]0;title\x07').changed).toBe(false)
})

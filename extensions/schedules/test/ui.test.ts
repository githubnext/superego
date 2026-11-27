// @vitest-environment happy-dom
// schedules, UI half: what a thread's schedules look like in details (⌘I) and the sidebar's mark, what the chip says,
// and a firing's context read back out of its message.
import { afterEach, expect, it } from 'vitest'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import schedules, { describe, nextWords, readFirings, reminderCaption } from '../src/ui.tsx'
import type { Facts, Schedule } from '../src/shared.ts'
import { HOUR, MINUTE } from '../src/when.ts'

const NOW = new Date(2026, 4, 5, 14, 0).getTime()
const schedule = (patch: Partial<Schedule>): Schedule => ({
  id: 's_1', thread: 't1', label: 'Check CI', message: 'Check CI on #212.', action: 'wake', when: { every: 30 * MINUTE, anchor: NOW }, said: 'every 30m',
  maxRuns: 48, next: NOW + 30 * MINUTE, runs: 0, missed: 0, paused: false, by: 'agent', created: NOW, ...patch,
})

let ui: TestWindow | undefined
afterEach(async () => { await ui?.unmount(); ui = undefined })

it('says when the next run is, short', () => {
  const facts: Facts = { next: NOW + 21 * MINUTE, label: 'Check CI', count: 1, paused: 0, pending: 0 }
  expect(nextWords(facts, NOW)).toBe('in 21m')
  expect(nextWords({ ...facts, next: NOW + 3 * HOUR }, NOW)).toBe('17:00')
  expect(nextWords({ ...facts, next: NOW + 20 * HOUR }, NOW)).toBe('tomorrow 10:00')
  expect(nextWords({ ...facts, next: null, paused: 1 }, NOW)).toBe('paused')
  expect(nextWords({ ...facts, next: NOW - MINUTE, pending: 1 }, NOW)).toBe('waiting')
})

it("describes a schedule's row: when, where it stands, its runs and who made it", () => {
  const thread = testThread({ id: 't1' })
  expect(describe(schedule({ until: 'CI is green' }), thread, NOW)).toEqual({ when: 'Every 30 min until CI is green · next 14:30', more: 'Up to 48 runs · made by the agent' })
  expect(describe(schedule({ runs: 3, paused: true, by: 'user' }), thread, NOW)).toEqual({ when: 'Every 30 min · paused', more: 'Run 3 of 48' })
  expect(describe(schedule({ pending: { since: NOW, due: NOW, missed: 0 } }), { ...thread, status: { state: 'blocked', kind: 'question' } }, NOW).when)
    .toBe('Every 30 min · waiting for your answer')
  expect(describe(schedule({ when: { at: NOW + 19 * HOUR }, maxRuns: 1, by: 'github' }), thread, NOW)).toEqual({ when: 'Tomorrow 09:00', more: 'made by github' })
})

it("lists a thread's schedules in details, paused ones quiet, with a mark on its row", async () => {
  const facts: Facts = { next: Date.now() + 2 * HOUR, label: 'Check CI', count: 2, paused: 1, pending: 0 }
  const thread = testThread({ id: 't1', facts: { schedules: facts } })
  const list = [schedule({ next: Date.now() + 2 * HOUR }), schedule({ id: 's_2', label: 'Check the error rate', paused: true, by: 'user' })]
  ui = await mountUi({ extensions: [schedules], machines: [fakeMachine({ threads: [thread], values: { 'schedules.thread': { t1: list } } })] })
  const details = await ui.render({ slot: 'details.section', thread })
  await ui.until(() => details.container.querySelectorAll('.schedules-row').length === 2, 'both rows')
  const rows = [...details.container.querySelectorAll('.schedules-row')]
  expect(rows.map((r) => r.querySelector('.schedules-row__label')?.textContent)).toEqual(['Check CI', 'Check the error rate'])
  expect(rows.map((r) => r.classList.contains('is-paused'))).toEqual([false, true])
  expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Run now', 'Resume', 'Edit', 'Cancel'])
  await details.unmount()
  const mark = await ui.render({ slot: 'thread.badge', thread })
  expect(mark.container.querySelector('.thread-badge')?.getAttribute('title')).toMatch(/^Check CI at \d\d:\d\d · 2 schedules$/)
  expect(mark.container.querySelector('.thread-badge svg')).not.toBeNull()
  await mark.unmount()
  const none = testThread({ id: 't2' })
  const unmarked = await ui.render({ slot: 'thread.badge', thread: none })
  expect(unmarked.container.innerHTML).toBe('')
  await unmarked.unmount()
})

it("reads a firing's context out of its message, which leaves the bubble", () => {
  const context = "⏰ Scheduled: Check CI (run 4 of up to 48, every 30 min; next 15:00). The message is this schedule's (s_1), sent for the user, not typed by them.\nLate: it was due 14:00 and ran 14:32."
  expect(readFirings([{ type: 'text', text: 'Check CI on #212.' }, { type: 'text', text: context }]))
    .toEqual({ items: [{ label: 'Check CI', what: 'run 4 of 48', late: true }], blocks: [1] })
  expect(readFirings([{ type: 'text', text: 'Check CI on #212.' }])).toBeUndefined()
})

it('makes a schedule in the form, saying what its time comes to as it’s typed', async () => {
  const thread = testThread({ id: 't1' })
  const understood = { how: 'every weekday at 09:00', times: [NOW + 19 * HOUR, NOW + 43 * HOUR], repeats: true, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }
  const machine = fakeMachine({
    threads: [thread], values: { 'schedules.thread': { t1: [] } },
    methods: {
      'schedules.understand': ({ when }: { when: string }) => { if (when !== 'every weekday at 9') throw new Error(`"${when}" isn't a time I understand.`); return understood },
      'schedules.add': (params: unknown) => params,
    },
  })
  ui = await mountUi({ extensions: [schedules], machines: [machine], select: { thread: 't1' }, window: true })
  const page = ui.window!
  await ui.dispatch('schedules.new')
  await ui.until(() => Boolean(document.querySelector('.schedules-form')), 'the form')
  await ui.type('#schedules-message', 'Look at the error rate')
  await ui.type('#schedules-when', 'whenever')
  await ui.until(() => document.querySelector('.schedules-form__hint')?.textContent === '"whenever" isn\'t a time I understand.', 'what it can’t read')
  const when = document.querySelector<HTMLInputElement>('#schedules-when')!
  await ui.type('#schedules-when', 'every weekday at 9')
  expect(when.value).toBe('every weekday at 9')
  await ui.until(() => /^Every weekday at 09:00: .+, .+/.test(document.querySelector('.schedules-form__hint')?.textContent ?? ''), 'what it comes to')
  // Repeating: it asks until when.
  expect(document.querySelector('#schedules-until')).not.toBeNull()
  await page.click('Remind me')
  await page.click('button.superego-button--primary')
  await ui.until(() => machine.calls.some((c) => c.method === 'action.run' || c.method === 'schedules.add'), 'saved')
  const saved = machine.calls.find((c) => c.method === 'action.run' || c.method === 'schedules.add')!
  expect(JSON.stringify(saved.params)).toContain('"action":"notify"')
  expect(JSON.stringify(saved.params)).toContain('"when":"every weekday at 9"')
})

it("says under a reminder which schedule and run it is, and how late", () => {
  expect(reminderCaption({ id: 's_1', label: 'Stretch', message: 'Stretch your legs.', run: 3, maxRuns: 48, how: 'every 2 h', late: NOW })).toBe('every 2 h, run 3 of 48 · due 14:00, late')
  expect(reminderCaption({ id: 's_1', label: "Review Mia's PR", message: "Review Mia's PR", run: 1 })).toBe('')
})

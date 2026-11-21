// @vitest-environment happy-dom
// A phone's thread sheet (the narrow layout): a drawer from the foot, opened from the thread's title in the bar at the
// top, drawn in the window (so its styles reach it) with the thread's tools in it; Escape or a tap beside it closes it,
// the focus back on the title. The swipes are Base UI's Drawer's, which a browser alone can try.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const sheet = () => $('.app__sheet .thread-sheet')
const title = () => $('.app__mobiletitle')!

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('opens from the title over the thread, and closes on Escape or a tap beside it, back to the title', async () => {
  const first = await daemon.thread('hello', { title: 'first' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: first.id }, narrow: true })
  await ui.until(() => $('.app.is-narrow .app__mobiletitle-text')?.textContent === 'first', 'the narrow layout')
  expect(sheet()).toBeNull()
  expect(title().getAttribute('aria-expanded')).toBe('false')

  title().focus()
  title().click()
  await ui.until(() => Boolean(sheet()?.querySelector('.thread-sheet__title')), 'the sheet, the thread in it')
  expect(sheet()!.closest('.app')).toBe($('.app'))
  expect(sheet()!.getAttribute('role')).toBe('dialog')
  expect(sheet()!.querySelector('.thread-sheet__title')!.textContent).toBe('first')
  expect(title().getAttribute('aria-expanded')).toBe('true')
  sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await ui.until(() => !sheet(), 'shut by Escape')
  await ui.until(() => document.activeElement === title(), 'the focus back on the title')

  title().click()
  await ui.until(() => Boolean(sheet()), 'open again')
  const beside = $('.app__sheet')!
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) beside.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' } as PointerEventInit))
  await ui.until(() => !sheet(), 'shut by a tap beside it')
})

it('is a menu: a row for the model, pinning and archiving', async () => {
  const first = await daemon.thread('hello', { title: 'first' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: first.id }, narrow: true })
  await ui.until(() => $('.app.is-narrow .app__mobiletitle-text')?.textContent === 'first', 'the narrow layout')
  title().click()
  const row = (id: string) => sheet()?.querySelector<HTMLButtonElement>(`[data-item="${id}"]`)
  await ui.until(() => Boolean(row('archive')), 'the rows')
  expect(row('pin')!.textContent).toBe('Pin')
  expect(row('archive')!.textContent).toBe('Archive')
  // The model's row says what its menu item does, split at the colon; choosing it shows the details under the rows.
  await ui.until(() => row('view:threads.model')?.querySelector('.thread-sheet__words')?.textContent === 'Model', "the model's row")
  row('view:threads.model')!.click()
  await ui.until(() => Boolean(sheet()?.querySelector('.threads-details')), 'the details in the sheet')
  expect(row('view:threads.model')!.getAttribute('aria-pressed')).toBe('true')

  // Archiving from it closes it.
  row('archive')!.click()
  await ui.until(() => !sheet(), 'closed by archiving')
  await ui.until(() => Boolean($('.thread__unarchive')), 'archived, Unarchive in its composer')
  title().click()
  await ui.until(() => row('unarchive')?.textContent === 'Unarchive' && !row('pin'), 'Unarchive in its place, and no pinning')
})

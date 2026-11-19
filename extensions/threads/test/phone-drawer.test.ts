// @vitest-environment happy-dom
// A phone's sidebar (the narrow layout): a drawer over the thread, opened from ☰ in the bar at the top, drawn
// in the window (so its styles reach it) with the threads listed as in the sidebar; picking one shows it and closes the
// drawer, and Escape or a tap beside it closes it too. The swipes are Base UI's Drawer's, which a browser alone can try.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const drawer = () => $('.app__drawer .app__sidebar')
const rowOf = (title: string) => $$('.app__drawer .superego-list-item').find((li) => li.querySelector('.superego-list-item__body')?.textContent?.startsWith(title))
const menu = () => $('.app__mobilebar button')!

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('opens from ☰ over the thread, lists the threads, and closes on a pick, Escape or a tap beside it', async () => {
  const first = await daemon.thread('hello', { title: 'first' })
  await daemon.thread('hello', { title: 'second' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: first.id }, narrow: true })
  await ui.until(() => Boolean($('.app.is-narrow .app__mobilebar')), 'the narrow layout')
  expect(drawer()).toBeNull()
  expect(menu().getAttribute('aria-expanded')).toBe('false')

  menu().click()
  await ui.until(() => Boolean(rowOf('second')), 'the drawer, the threads in it')
  expect(drawer()!.closest('.app')).toBe($('.app'))
  expect(drawer()!.getAttribute('role')).toBe('dialog')
  expect(menu().getAttribute('aria-expanded')).toBe('true')
  rowOf('second')!.click()
  await ui.until(() => !drawer() && $('.app__mobiletitle-text')?.textContent === 'second', 'the thread picked shown, the drawer shut')

  menu().click()
  await ui.until(() => Boolean(drawer()), 'open again')
  drawer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await ui.until(() => !drawer(), 'shut by Escape')

  menu().click()
  await ui.until(() => Boolean(drawer()), 'and again')
  rowOf('second')!.click()
  await ui.until(() => !drawer(), 'shut by picking the thread already shown')

  menu().click()
  await ui.until(() => Boolean(drawer()), 'once more')
  const beside = $('.app__drawer')!
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) beside.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' } as PointerEventInit))
  await ui.until(() => !drawer(), 'shut by a tap beside it')
})

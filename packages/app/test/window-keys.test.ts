// @vitest-environment happy-dom
// The window drawn whole (superego/testing's mountUi) over a real daemon, driven by its keys: ⌘K for commands only,
// placing a view and resetting the layout from it; ⌘L to go to a thread; the action log of what ran and from where; back
// and forward through the threads shown.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineUiExtension } from '../src/renderer/extension-api.ts'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const titled = () => $('.thread__title')?.textContent

/** A view of the window's that fits beside a thread and in a pane, put nowhere until asked. */
const notes = defineUiExtension({
  name: 'notes',
  setup(superego) {
    superego.view('notes.view', { title: 'Notes', context: 'thread', fits: ['beside', 'pane'], component: () => 'the notes' })
  },
})

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('keeps ⌘K to commands, and ⌘L finds a thread by name and opens it', async () => {
  await daemon.thread('hello from a test', { title: 'hello there' })
  await daemon.thread(undefined, { title: 'another' })
  ui = await mountUi({ window: true, machines: [daemon] })
  await ui.key('mod+k')
  await ui.until(() => Boolean($('.palette__input')), 'the palette')
  expect($$('.palette__list li').length).toBeGreaterThan(0)
  expect($$('.palette__list li').some((li) => li.textContent?.includes('hello there'))).toBe(false)
  await ui.key('escape')
  await ui.until(() => !$('.palette__input'), 'the palette closed')

  await ui.key('mod+l')
  await ui.until(() => Boolean($('.navigator .palette__input')), 'the navigator')
  await ui.type('.navigator .palette__input', 'hello')
  await ui.until(() => Boolean($('.palette__list li.is-active')?.textContent?.includes('hello there')), 'the thread found')
  await ui.key('enter')
  await ui.until(() => !$('.palette__input') && titled() === 'hello there', 'the thread opened')
})

it('shows a view where it fits and isn’t from ⌘K, and resets the layout from it', async () => {
  const thread = await daemon.thread(undefined, { title: 'placed' })
  ui = await mountUi({ window: true, extensions: [notes], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => titled() === 'placed', 'the thread shown')
  const pick = async (query: string, title: string) => {
    await ui.key('mod+k')
    await ui.until(() => Boolean($('.palette__input')), 'the palette')
    await ui.type('.palette__input', query)
    await ui.until(() => Boolean($('.palette__list li.is-active')?.textContent?.includes(title)), title)
    await ui.key('enter')
  }
  await pick('show notes beside', 'Show Notes beside the thread')
  await ui.until(() => $('.app__beside')?.textContent?.includes('the notes') === true, 'the notes beside the thread')
  expect(ui.placed('beside', { thread: thread.id })).toContain('notes.view')
  await pick('reset layout', 'Reset layout')
  await ui.until(() => !$('.app__beside'), 'the layout reset')
  expect(ui.placed('beside', { thread: thread.id })).not.toContain('notes.view')
})

it('moves a view from its menu: beside the thread to a pane, and back', async () => {
  const thread = await daemon.thread(undefined, { title: 'moved' })
  ui = await mountUi({ window: true, extensions: [notes], machines: [daemon], select: { thread: thread.id }, layout: { place: { 'notes.view': 'beside' } } })
  await ui.until(() => Boolean($('.app__beside .placed-view[data-view="notes.view"]')), 'the notes beside the thread')
  const moveTo = async (button: string, place: string) => {
    $(button)!.click()
    await ui.until(() => $$('.view-menu .superego-menu__item').some((i) => i.textContent === 'Move to'), 'the view menu')
    $$('.view-menu .superego-menu__item').find((i) => i.textContent === 'Move to')!.click()
    await ui.until(() => Boolean($(`.view-menu__places [data-place="${place}"]`)), `Move to ${place}`)
    $(`.view-menu__places [data-place="${place}"]`)!.click()
    await ui.settle()
  }
  await moveTo('.placed-view[data-view="notes.view"] .view-menu__button', 'pane')
  await ui.until(() => $('.panes__column:not(.panes__column--thread)')?.textContent?.includes('the notes') === true && !$('.app__beside'), 'the notes in a pane')
  expect(ui.placed('pane', { thread: thread.id })).toContain('notes.view')
  await moveTo('.panes__tab .view-menu__button', 'beside')
  await ui.until(() => Boolean($('.app__beside')?.textContent?.includes('the notes')) && !$('.panes__column:not(.panes__column--thread)'), 'the notes beside the thread again')
  expect(ui.placed('beside', { thread: thread.id })).toContain('notes.view')
})

it('logs what ran through the router, with where it came from', async () => {
  await daemon.thread(undefined, { title: 'logged' })
  ui = await mountUi({ window: true, machines: [daemon] })
  await ui.key('mod+/')
  await ui.key('mod+/')
  await ui.key('mod+l')
  await ui.until(() => Boolean($('.navigator .palette__input')), 'the navigator')
  await ui.type('.navigator .palette__input', 'logged')
  await ui.until(() => Boolean($('.palette__list li.is-active')?.textContent?.includes('logged')), 'the thread found')
  await ui.key('enter')
  await ui.until(() => titled() === 'logged', 'the thread opened')
  await ui.key('mod+k')
  await ui.type('.palette__input', 'action log')
  await ui.until(() => Boolean($('.palette__list li.is-active')), 'the log found')
  await ui.key('enter')
  const rows = () => $$('.action-log__table tr').map((tr) => tr.textContent ?? '')
  await ui.until(() => rows().some((r) => r.includes('app.sidebar') && r.includes('keys')), 'the key press logged')
  expect(rows().some((r) => r.includes('thread.select') && r.includes('navigator'))).toBe(true)
  await ui.key('escape')
  await ui.until(() => !$('.action-log'), 'the log closed')
})

it('goes back and forward through the threads shown, by key and by its buttons', async () => {
  const [first, second] = [await daemon.thread(undefined, { title: 'first' }), await daemon.thread(undefined, { title: 'second' })]
  ui = await mountUi({ window: true, machines: [daemon] })
  await ui.select({ thread: first.id })
  await ui.select({ thread: second.id })
  await ui.until(() => titled() === 'second', 'the second shown')
  const back = () => $('.app__back') as HTMLButtonElement
  const forward = () => $('.app__forward') as HTMLButtonElement
  expect([back().disabled, forward().disabled]).toEqual([false, true])
  await ui.key('mod+[')
  await ui.until(() => titled() === 'first' && !forward().disabled, 'back to the first')
  await ui.key('mod+]')
  await ui.until(() => titled() === 'second' && forward().disabled, 'forward again')
  back().click()
  await ui.until(() => titled() === 'first', 'the back button')
  forward().click()
  await ui.until(() => titled() === 'second', 'the forward button')
})

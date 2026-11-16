// @vitest-environment happy-dom
// The sidebar in the window drawn whole (superego/testing's mountUi) over a real daemon: its ··· menu (sorting, hiding
// it), ⌘/ to hide it (the threads as dots in the rail) and show it again, the details beside the thread (⌘I, the model
// button), the archived threads at its end, a thread another started right under it, and ⌘⇧] ⌘⇧[ down and up the rows.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const titled = () => $('.thread__title')?.textContent
const rows = (within = '.threads-project') => $$(`${within} .superego-list-item`)
const rowOf = (title: string, within?: string) => rows(within).find((li) => li.querySelector('.superego-list-item__body')?.textContent?.startsWith(title))
const sidebar = () => Boolean($('.app__sidebar'))
const dots = () => Boolean($('.threads-rail .threads-rail__dot'))
const menuItem = (text: string) => $$('.superego-menu .superego-menu__item').find((i) => i.textContent?.includes(text))

let daemon: TestDaemon
let ui: TestWindow
// A Mac's keys: elsewhere ⌘ is Ctrl, and Ctrl+I is the prompt's (focus.prompt) before the details'.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('sorts from its ··· menu, and hides from there, from ⌘/ and from the rail, the threads as dots meanwhile', async () => {
  await daemon.thread('hello', { title: 'hello' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon] })
  await ui.until(() => Boolean(rowOf('hello')), 'the thread listed')
  $('.threads-menu-trigger')!.click()
  await ui.until(() => Boolean(menuItem('Needs you first')), 'the ··· menu')
  menuItem('Needs you first')!.click()
  const appSetting = async (key: string) => ((await window.superego.call('app', 'settings.watch', {})) as { value: { values: Record<string, unknown> } }).value.values[key]
  await ui.until(async () => await appSetting('app.sort') === 'status', 'sorted by status')
  await ui.key('mod+/')
  await ui.until(() => !sidebar() && dots(), 'hidden: the sidebar gone, the threads as dots')
  await ui.key('mod+/')
  await ui.until(() => Boolean($('.threads-project')) && !$('.threads-rail'), 'the list again')
  $('.threads-menu-trigger')!.click()
  await ui.until(() => Boolean(menuItem('Hide sidebar')), 'the ··· menu again')
  menuItem('Hide sidebar')!.click()
  await ui.until(() => !sidebar() && dots(), 'hidden from the menu')
  $('.threads-rail__button')!.click()
  await ui.until(() => Boolean($('.threads-project')), 'the list from the rail')
})

it('shows the details beside the thread from ⌘I and from the model button, the sidebar shown or not', async () => {
  const thread = await daemon.thread('hello', { title: 'detailed' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => titled() === 'detailed', 'the thread shown')
  await ui.key('mod+i')
  await ui.until(() => Boolean($('.threads-details')?.textContent?.includes('Machine')), 'the details')
  await ui.key('mod+i')
  await ui.until(() => !$('.threads-details') && !$('.app__beside'), 'the details closed, their column gone')
  await ui.until(() => Boolean($('.app__titlebar .threads-model')?.textContent), 'the model in the title bar')
  $('.threads-model')!.click()
  await ui.until(() => Boolean($('.threads-details')) && Boolean($('.threads-model')?.classList.contains('is-on')), 'the details from the model button')
  $('.threads-model')!.click()
  await ui.until(() => !$('.threads-details'), 'and off again')
  await ui.key('mod+/')
  await ui.until(() => !sidebar(), 'the sidebar hidden')
  await ui.key('mod+i')
  await ui.until(() => Boolean($('.threads-details')), 'the details with the sidebar hidden')
  await ui.key('mod+i')
  await ui.until(() => !$('.threads-details') && !$('.threads-model')?.classList.contains('is-on'), 'and off')
})

it('keeps the archived at its end, closed; opened, one list across projects', async () => {
  const elsewhere = join(daemon.dataDir, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  await daemon.thread(undefined, { title: 'kept' })
  const old = await daemon.thread(undefined, { title: 'old', cwd: elsewhere })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon] })
  await ui.until(() => Boolean(rowOf('old')), 'the thread listed')
  await daemon.call('thread.archive', { thread: old.id })
  await ui.until(() => !rowOf('old') && $('.threads-archived__head')?.getAttribute('aria-expanded') === 'false', 'archived out of its project, the archived closed')
  $('.threads-archived__head')!.click()
  await ui.until(() => Boolean(rowOf('old', '.threads-archived')), 'the archived listed')
  // Picked there, it shows (read only: window-threads.test.ts), and is still archived.
  rowOf('old', '.threads-archived')!.click()
  await ui.until(() => titled() === 'old' && Boolean($('.titlebar__archived')), 'the archived thread shown')
  expect(rowOf('old', '.threads-archived')).toBeDefined()
  $('.composer__unarchive')!.click()
  await ui.until(() => Boolean(rowOf('old')) && !rowOf('old', '.threads-archived'), 'unarchived, back in its project')
})

it('puts a thread another started right under it, though newer, and steps down and up the rows as shown', async () => {
  const elsewhere = join(daemon.dataDir, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  const parent = await daemon.thread(undefined, { title: 'parent', cwd: elsewhere })
  await daemon.thread(undefined, { title: 'between', cwd: elsewhere })
  await daemon.call('thread.start', { cwd: elsewhere, title: 'offshoot', parent: parent.id })
  await daemon.thread(undefined, { title: 'here' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: parent.id } })
  await ui.until(() => {
    const list = rows(), at = list.findIndex((li) => li === rowOf('parent'))
    return at >= 0 && list[at + 1] === rowOf('offshoot') && Boolean(rowOf('offshoot')?.classList.contains('threads-child'))
  }, 'the offshoot under its parent')
  await ui.until(() => titled() === 'parent', 'the parent shown')
  await ui.key('mod+shift+]')
  await ui.until(() => titled() === 'offshoot', 'down to the offshoot')
  await ui.key('mod+/')
  await ui.until(() => !sidebar(), 'the sidebar hidden')
  await ui.key('mod+shift+[')
  await ui.until(() => titled() === 'parent', 'up to its parent, the sidebar hidden')
  await ui.key('mod+/')
  await ui.until(sidebar, 'the sidebar back')
  // From a project's end on to the next project's first.
  const shown = rows().map((li) => li.querySelector('.superego-list-item__body')?.textContent ?? '')
  const last = shown.at(-1)!
  rows().at(-1)!.click()
  await ui.until(() => Boolean(titled() && last.startsWith(titled()!)), 'the last row shown')
  await ui.key('mod+shift+[')
  await ui.until(() => Boolean(titled() && shown.at(-2)!.startsWith(titled()!)), 'up a row, across projects')
})

it('draws a thread link in your message as the thread it names', async () => {
  const thread = await daemon.thread(undefined, { title: 'linking' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: thread.id } })
  await daemon.call('thread.send', { thread: thread.id, text: `From [this thread](thread:${thread.id}):\nsee` })
  await ui.until(() => Boolean($$('.msg--user').at(-1)?.querySelector('a.thread-ref')), 'the link drawn as a thread')
})

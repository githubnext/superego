// @vitest-environment happy-dom
// Focus in the window, the Threads sidebar drawn whole: a thread focused from its row's menu and ⌘⌥F; focus mode (⌘⇧F,
// or for an hour from the heading's ◎) narrowing the list to them and what needs you, ⌘⇧] and ⌘⇧[ stepping through
// what's shown; sub-threads following their parent in; archived threads leaving; and nothing narrowed where focus is
// switched off.
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMachine, mountUi, testDaemon, testThread, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import type { Status, ThreadInfo } from '@superego/protocol'
import threads from '@superego/threads/ui'
import focus, { AN_HOUR } from '../src/ui.tsx'
import { about, FOCUSED, ON, UNTIL } from '../src/shared.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const titled = () => $('.thread__title')?.textContent
const rows = () => $$('.threads-project:not(.threads-pinned) .superego-list-item')
const titles = () => rows().map((li) => li.querySelector('.threads__title')?.textContent)
const rowOf = (title: string) => rows().find((li) => li.querySelector('.threads__title')?.textContent === title)
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }))
const menuItem = (text: string) => $$('.superego-menu .superego-menu__item').find((i) => i.querySelector('.superego-menu__text')?.textContent === text)
const heading = () => $('.threads__head > span')?.textContent
const appSetting = async (key: string) => ((await window.superego.call('app', 'settings.watch', {})) as { value: { values: Record<string, unknown> } }).value.values[key]
const focused = async () => ((await appSetting(FOCUSED)) as { thread: string }[] | undefined ?? []).map((f) => f.thread).sort()
const set = (key: string, value: unknown) => window.superego.call('app', 'app.settings.set', { key, value })

let ui: TestWindow | undefined
let daemon: TestDaemon | undefined
// A Mac's keys: ⌘ is ⌘.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
afterEach(async () => {
  vi.useRealTimers()
  await ui?.unmount(); ui = undefined
  await daemon?.close(); daemon = undefined
})

const now = Date.now()
const status = (state: Status['state'], kind?: 'question'): Status => ({ state, ...(kind ? { kind } : {}) })
// Newest first: the list's order. The transcript of the thread shown never comes: only the list is under test.
const listed = (): ThreadInfo[] => [
  testThread({ id: 'mine', title: 'Mine', activeAt: now }),
  testThread({ id: 'asks', title: 'Asks', activeAt: now - 1000, status: status('blocked', 'question') }),
  testThread({ id: 'rest', title: 'Rest', activeAt: now - 2000 }),
  testThread({ id: 'also', title: 'Also mine', activeAt: now - 3000, cwd: '/site', project: { root: '/site', name: 'site' } }),
  testThread({ id: 'broke', title: 'Broke', activeAt: now - 4000, status: status('error') }),
  testThread({ id: 'other', title: 'Other', activeAt: now - 5000, cwd: '/site', project: { root: '/site', name: 'site' } }),
]
const fake = () => fakeMachine({ threads: listed(), extensions: ['focus'], methods: { 'thread.watch': () => new Promise(() => {}) } })
const mount = (machine = fake(), select = 'mine') => mountUi({ window: true, extensions: [threads, focus], machines: [machine], select: { thread: select } })

it('focuses a thread from its row menu and ⌘⌥F, and unfocuses it; marked while the mode is off', async () => {
  ui = await mount()
  await ui.until(() => Boolean(rowOf('Also mine')), 'the threads listed')
  rightClick(rowOf('Also mine')!)
  await ui.until(() => Boolean(menuItem('Focus')), 'Focus in the row menu')
  menuItem('Focus')!.click()
  await ui.until(async () => (await focused()).join() === 'also', 'focused from the menu')
  await ui.until(() => Boolean(rowOf('Also mine')?.querySelector('.focus-glyph')), 'marked')
  expect(rowOf('Mine')?.querySelector('.focus-glyph')).toBeNull()
  await ui.key('mod+alt+f')
  await ui.until(async () => (await focused()).join() === 'also,mine', 'the thread shown focused, from ⌘⌥F')
  rightClick(rowOf('Also mine')!)
  await ui.until(() => Boolean(menuItem('Unfocus')), 'Unfocus in its menu now')
  menuItem('Unfocus')!.click()
  await ui.until(async () => (await focused()).join() === 'mine', 'unfocused')
  await ui.key('mod+alt+f')
  await ui.until(async () => (await focused()).length === 0, 'and the one shown, from ⌘⌥F')
})

it('narrows the list to what is in focus and what needs you, steps through only that, and widens again', async () => {
  ui = await mount()
  await set(FOCUSED, [{ machine: 'local', thread: 'mine' }, { machine: 'local', thread: 'also' }])
  await ui.until(() => titles().length === 6 && heading() === 'Threads', 'everything, the mode off')
  await ui.key('mod+shift+f')
  await ui.until(() => heading() === 'Focus' && titles().join() === 'Mine,Asks,Broke,Also mine', 'in focus, and what needs you, under their projects')
  expect($('.focus-more')?.textContent).toBe('Show 2 more')
  expect($('.threads-archived')).toBeNull()
  expect($('.focus-button')?.getAttribute('aria-pressed')).toBe('true')
  // ⌘⇧] and ⌘⇧[ go through the rows shown.
  await ui.until(() => titled() === 'Mine', 'the thread shown')
  for (const next of ['Asks', 'Broke', 'Also mine', 'Mine']) {
    await ui.key('mod+shift+]')
    await ui.until(() => titled() === next, `down to ${next}`)
  }
  await ui.key('mod+shift+[')
  await ui.until(() => titled() === 'Also mine', 'up, around the end')
  $('.focus-more')!.click()
  await ui.until(() => heading() === 'Threads' && titles().length === 6, 'Show 2 more: everything again')
  expect(await appSetting(ON)).toBe(false)
})

it('says how to focus with nothing in focus, and still shows what needs you', async () => {
  ui = await mount()
  await ui.until(() => titles().length === 6, 'the threads listed')
  await ui.key('mod+shift+f')
  // The thread shown stays shown, as it does in a folded project.
  await ui.until(() => titles().join() === 'Mine,Asks,Broke', 'only what needs you, and the thread shown')
  expect($('.focus-empty')?.textContent).toBe('Nothing in focus. Right-click a thread and choose Focus.')
})

it('turns itself off when an hour of focus is up', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
  ui = await mount()
  await ui.until(() => Boolean($('.focus-button')), 'the ◎ in the heading')
  $('.focus-button')!.click()
  await ui.until(() => Boolean(menuItem('Focus for 1 hour')), 'its menu')
  menuItem('Focus for 1 hour')!.click()
  await ui.until(() => heading() === 'Focus' && $('.focus-left')?.textContent === '60 min', 'on, saying for how long')
  expect(await appSetting(UNTIL)).toBeTypeOf('number')
  await ui.until(() => $('.focus-button')?.getAttribute('aria-label') === 'Focus mode: 60 min left', 'the button says it is timed')
  expect($('.focus-button circle[stroke-dasharray]')).not.toBeNull()
  vi.advanceTimersByTime(AN_HOUR / 2)
  await ui.until(() => $('.focus-button')?.getAttribute('aria-label') === 'Focus mode: 30 min left' && $('.focus-left')?.textContent === '30 min', 'half an hour on')
  vi.advanceTimersByTime(AN_HOUR / 2)
  await ui.until(() => heading() === 'Threads' && titles().length === 6, 'off again, an hour on')
  expect(await appSetting(ON)).toBe(false)
  expect(await appSetting(UNTIL)).toBe(0)
})

// A test daemon is given focus's `about`, as the app's daemon lists it: the machine has focus, until it's switched off.
it('takes a thread\'s sub-threads in with it, and one it starts later; an archived one leaves', async () => {
  daemon = await testDaemon({ model: 'echo', extensions: [about] })
  const parent = await daemon.thread(undefined, { title: 'parent' })
  await daemon.call('thread.start', { title: 'earlier', parent: parent.id })
  await daemon.thread(undefined, { title: 'loose' })
  ui = await mountUi({ window: true, extensions: [threads, focus], machines: [daemon], select: { thread: parent.id } })
  await ui.until(() => titles().length === 3, 'the threads listed')
  await ui.key('mod+alt+f')
  await ui.until(async () => (await focused()).length === 2, 'the parent focused, and the thread it started with it')
  const later = await daemon.call<ThreadInfo>('thread.start', { title: 'later', parent: parent.id })
  await ui.until(async () => (await focused()).includes(later.id), 'one it starts later joins')
  await ui.key('mod+shift+f')
  await ui.until(() => titles().join() === 'parent,later,earlier' || titles().join() === 'parent,earlier,later', 'the family alone')
  expect(rowOf('loose')).toBeUndefined()
  await daemon.call('thread.archive', { thread: later.id })
  await ui.until(async () => !(await focused()).includes(later.id), 'archived, it leaves the set')
})

it('narrows nothing where focus is switched off', async () => {
  daemon = await testDaemon({ model: 'echo', extensions: [about] })
  const one = await daemon.thread(undefined, { title: 'one' })
  await daemon.thread(undefined, { title: 'two' })
  ui = await mountUi({ window: true, extensions: [threads, focus], machines: [daemon], select: { thread: one.id } })
  await ui.until(() => titles().length === 2 && Boolean($('.focus-button')), 'listed, focus there')
  await set(FOCUSED, [{ machine: 'local', thread: one.id }])
  await ui.key('mod+shift+f')
  await ui.until(() => titles().join() === 'one', 'narrowed')
  await daemon.call('settings.set', { key: 'extensions.focus', value: false })
  await ui.until(() => titles().length === 2 && heading() === 'Threads' && !$('.focus-button'), 'switched off: everything, no ◎')
})

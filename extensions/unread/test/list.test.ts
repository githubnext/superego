// @vitest-environment happy-dom
// ⌘U: the unread threads, the most pressing first and the one shown left out, narrowed as you type; ⏎ goes to one.
// With nothing unread it says so instead of listing nothing. The bell opens the same list.
import { afterEach, expect, it } from 'vitest'
import { groupProjects, unreadList, type MachineEntry } from '@superego/app/ui'
import { fakeMachine, mountUi, testThread, type TestWindow } from '@superego/sdk/testing'
import type { Status, ThreadInfo } from '@superego/protocol'
import unread from '../src/ui.tsx'
import { filterUnread, shorten } from '../src/unread.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const titles = () => $$('.unread-list .unread-list__title').map((t) => t.textContent)

const machine = (id: string): MachineEntry => ({ id, label: id, state: 'connected' })
const thread = (id: string, root: string, activeAt: number, status: Status): ThreadInfo =>
  ({ id, title: id, cwd: root, createdAt: 0, activeAt, project: { root, name: root.slice(1) }, status })

const projects = groupProjects([machine('local'), machine('box')], {
  local: [
    thread('done-new', '/app', 50, { state: 'done', msg: 'Shipped the **login** fix' }),
    thread('working', '/app', 45, { state: 'working' }),
    thread('failed', '/site', 30, { state: 'error', msg: 'Tests failed' }),
    thread('idle', '/site', 25, { state: 'idle' }),
  ],
  box: [thread('asks', '/app', 20, { state: 'blocked', kind: 'question', msg: 'Which branch?' }), thread('done-old', '/app', 10, { state: 'done' })],
}, 'recent')
const ids = (list: readonly { thread: ThreadInfo }[]) => list.map((u) => u.thread.id)

it('lists what needs you, then what failed, then what finished, newest first within each, without the thread shown', () => {
  expect(ids(unreadList(projects))).toEqual(['asks', 'failed', 'done-new', 'done-old'])
  expect(ids(unreadList(projects, { machine: 'local', thread: 'failed' }))).toEqual(['asks', 'done-new', 'done-old'])
})

it('narrows to what matches the title, project, machine or message, in the same order', () => {
  const list = unreadList(projects)
  expect(filterUnread(list, '')).toBe(list)
  expect(ids(filterUnread(list, 'app'))).toEqual(['asks', 'done-new', 'done-old'])
  expect(ids(filterUnread(list, 'box'))).toEqual(['asks', 'done-old'])
  expect(ids(filterUnread(list, 'branch'))).toEqual(['asks'])
  expect(filterUnread(list, 'zzz')).toEqual([])
})

it('shortens a message to one plain line', () => {
  expect(shorten('Shipped the **login** fix.\n\n- `a`\n- b')).toBe('Shipped the login fix. - a - b')
  expect(shorten('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`)
})

let ui: TestWindow | undefined
// A Mac's keys: elsewhere ⌘ is Ctrl, and Ctrl+U scrolls up (scroll.up) before it lists the unread.
Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
afterEach(async () => { await ui?.unmount(); ui = undefined })

const now = Date.now()
// The transcript of the thread shown never comes: only the list is under test.
const machineWith = (threads: ThreadInfo[]) => fakeMachine({ threads, methods: { 'thread.watch': () => new Promise(() => {}) } })
const threads = () => [
  testThread({ id: 'shown', title: 'Shown one', activeAt: now, status: { state: 'done', msg: 'Seen as it is shown' } }),
  testThread({ id: 'fixed', title: 'Fix the login', activeAt: now - 5 * 60_000, status: { state: 'done', msg: 'Fixed the **login** form' } }),
  testThread({ id: 'broke', title: 'Deploy', activeAt: now - 60_000, status: { state: 'error', msg: 'The build failed' } }),
  testThread({ id: 'asks', title: 'Pick a name', activeAt: now - 3 * 3_600_000, status: { state: 'blocked', kind: 'question', msg: 'Which name?' } }),
  testThread({ id: 'calm', title: 'Nothing new', activeAt: now, status: { state: 'idle' } }),
]

it('opens on ⌘U, most pressing first, each in a word, narrows as you type, and goes to the one picked', async () => {
  ui = await mountUi({ window: true, extensions: [unread], machines: [machineWith(threads())], select: { thread: 'shown' } })
  expect(await ui.press('mod+u')).toBe('unread.list')
  await ui.until(() => titles().length === 3, 'the list')
  expect(titles()).toEqual(['Pick a name', 'Deploy', 'Fix the login'])
  const fixed = $$('.unread-list li')[2]!
  expect(fixed.textContent).toContain('Fixed the login form')
  // Each says what it wants in a word.
  expect($$('.unread-list .palette__detail').map((d) => d.textContent)).toEqual(['Question', 'Failed', 'Done'])
  await ui.type('.unread-list .palette__input', 'login')
  await ui.until(() => titles().join() === 'Fix the login', 'narrowed')
  await ui.key('enter')
  await ui.until(() => !$('.unread-list'), 'closed')
  await ui.until(() => $('.thread__title')?.textContent === 'Fix the login', 'the thread shown')
})

it('closes on Esc, and on ⌘U again', async () => {
  ui = await mountUi({ window: true, extensions: [unread], machines: [machineWith(threads())] })
  await ui.key('mod+u')
  await ui.until(() => titles().length === 4, 'the list, with nothing shown to leave out')
  await ui.key('escape')
  await ui.until(() => !$('.unread-list'), 'closed by Esc')
  await ui.key('mod+u')
  await ui.until(() => Boolean($('.unread-list')), 'open again')
  await ui.press('mod+u')
  await ui.until(() => !$('.unread-list'), 'closed by ⌘U')
})

it('takes another key set in Settings → Hotkeys', async () => {
  ui = await mountUi({ window: true, extensions: [unread], machines: [machineWith(threads())] })
  await ui.dispatch('app.settings.set', { key: 'app.keys', value: { 'unread.list': 'mod+shift+u' } })
  // ⌘U no longer opens it (else ⌘⇧U would close it again).
  await ui.key('mod+u')
  await ui.key('mod+shift+u')
  await ui.until(() => Boolean($('.unread-list')), 'the list on its new key')
})

it('says there is nothing unread instead of opening an empty list', async () => {
  const calm = [testThread({ id: 'calm', title: 'Calm', status: { state: 'idle' } }), testThread({ id: 'only', title: 'Only', status: { state: 'done' } })]
  ui = await mountUi({ window: true, extensions: [unread], machines: [machineWith(calm)], select: { thread: 'only' } })
  await ui.press('mod+u')
  await ui.until(() => $('.unread-none')?.textContent === 'Nothing unread', 'said')
  expect($('.unread-list')).toBeNull()
  await ui.until(() => !$('.unread-none'), 'gone by itself', 3000)
})

it('opens the same list from the bell', async () => {
  ui = await mountUi({ window: true, extensions: [unread], machines: [machineWith(threads())], select: { thread: 'shown' } })
  const bell = await ui.render({ view: 'unread.bell', place: 'rail' })
  expect(bell.text()).toBe('3')
  await bell.click('3 unread')
  await ui.until(() => titles().length === 3, 'the list')
})

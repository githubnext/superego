// @vitest-environment happy-dom
// The sidebar in the window drawn whole (superego/testing's mountUi) over a real daemon: its ··· menu (sorting, hiding
// it), ⌘/ to hide it (the threads as dots in the rail) and show it again, the details beside the thread (⌘I, the model
// button), the archived threads at its end, a thread another started right under it, ⌘⇧] ⌘⇧[ down and up the rows,
// and pinned threads at the top, from every project and machine; projects, Pinned and a thread's offshoots folded.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { daemonMachine, mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const titled = () => $('.thread__title')?.textContent
const rows = (within = '.threads-project:not(.threads-pinned)') => $$(`${within} .superego-list-item`)
const rowOf = (title: string, within?: string) => rows(within).find((li) => li.querySelector('.superego-list-item__body')?.textContent?.startsWith(title))
const sidebar = () => Boolean($('.app__sidebar'))
const dots = () => Boolean($('.threads-rail .threads-rail__dot'))
const pinned = () => rows('.threads-pinned').map((li) => li.querySelector('.threads__title')?.textContent)
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }))
const appSetting = async (key: string) => ((await window.superego.call('app', 'settings.watch', {})) as { value: { values: Record<string, unknown> } }).value.values[key]
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
  await ui.dispatch('threads.sort.name')
  await ui.until(async () => await appSetting('app.sort') === 'name', 'sorted alphabetically, from ⌘K')
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

it('pins threads from every project and machine to the top, and to the top of their projects, and unpins them; archived, a thread leaves them', async () => {
  const box = await testDaemon({ model: 'echo' })
  try {
    const elsewhere = join(daemon.dataDir, 'elsewhere')
    await mkdir(elsewhere, { recursive: true })
    const here = await daemon.thread(undefined, { title: 'here' })
    const there = await daemon.thread(undefined, { title: 'there', cwd: elsewhere })
    await daemon.thread(undefined, { title: 'stays', cwd: elsewhere })
    const far = await box.thread(undefined, { title: 'far' })
    ui = await mountUi({ window: true, extensions: [threads], machines: [daemon, daemonMachine(box, 'box', 'Build box')], select: { thread: there.id } })
    await ui.until(() => Boolean(rowOf('here') && rowOf('there') && rowOf('far')), 'the threads listed')
    expect($('.threads-pinned')).toBeNull()

    // From a row's right-click menu, from the title bar, and from ⌘K's action.
    rightClick(rowOf('far')!)
    await ui.until(() => Boolean(menuItem('Pin')), 'the row menu')
    menuItem('Pin')!.click()
    await ui.until(() => pinned().join() === 'far', 'pinned, from the other machine')
    // Still under its project too, marked.
    expect(rowOf('far')?.querySelector('.threads__pin')).not.toBeNull()
    expect(rowOf('far', '.threads-pinned')?.querySelector('.threads-pinned__where')?.textContent).toMatch(/Build box/)
    $('.app__titlebar .thread__pin')!.click()
    await ui.until(() => pinned().join() === 'far,there' && $('.app__titlebar .thread__pin')?.getAttribute('aria-pressed') === 'true', 'the shown one pinned from the title bar')
    // At the top of its project, above the one newer.
    const project = (title: string) => rows().filter((li) => li.closest('section') === rowOf(title)!.closest('section')).map((li) => li.querySelector('.threads__title')?.textContent)
    expect(project('stays')).toEqual(['there', 'stays'])
    expect(rowOf('stays')?.querySelector('.threads__pin')).toBeNull()
    await ui.select({ thread: here.id })
    await ui.key('mod+k')
    await ui.until(() => Boolean($$('.palette__list li').find((li) => li.textContent?.includes('Pin thread'))), 'Pin thread in the palette')
    expect($$('.palette__list li').some((li) => li.textContent?.includes('Unpin thread'))).toBe(false)
    $$('.palette__list li').find((li) => li.textContent?.includes('Pin thread'))!.click()
    await ui.until(() => pinned().join() === 'far,there,here', 'pinned from the palette, last')
    expect(await appSetting('app.pins')).toEqual([{ machine: 'box', thread: far.id }, { machine: 'local', thread: there.id }, { machine: 'local', thread: here.id }])

    // Pinned hidden from the ··· menu, for every window: still pinned, at the tops of their projects.
    $('.threads-menu-trigger')!.click()
    await ui.until(() => Boolean(menuItem('Show pinned')), 'the ··· menu')
    menuItem('Show pinned')!.click()
    await ui.until(() => !$('.threads-pinned'), 'Pinned hidden')
    expect(await appSetting('app.pins.shown')).toBe(false)
    expect(rowOf('far')?.querySelector('.threads__pin')).not.toBeNull()
    expect(project('stays')).toEqual(['there', 'stays'])
    await ui.key('escape')
    $('.threads-menu-trigger')!.click()
    await ui.until(() => Boolean(menuItem('Show pinned')), 'the ··· menu again')
    menuItem('Show pinned')!.click()
    await ui.until(() => pinned().join() === 'far,there,here', 'Pinned shown again')
    await ui.key('escape')

    // ⌘⇧] goes down the pinned first.
    rowOf('far', '.threads-pinned')!.click()
    await ui.until(() => titled() === 'far', 'far shown')
    await ui.key('mod+shift+]')
    await ui.until(() => titled() === 'there', 'down the pinned')

    // Moved, then unpinned from the menu: back under its project.
    await ui.dispatch('thread.pin', { machine: 'local', thread: there.id, at: 0 })
    await ui.until(() => pinned().join() === 'there,far,here', 'moved first')
    rightClick(rowOf('far', '.threads-pinned')!)
    await ui.until(() => Boolean(menuItem('Unpin')), 'the pinned row menu')
    menuItem('Unpin')!.click()
    await ui.until(() => pinned().join() === 'there,here' && !rowOf('far')?.querySelector('.threads__pin'), 'unpinned, unmarked in its project')

    // Archived, it leaves the pins: unarchived, it's not pinned again.
    await daemon.call('thread.archive', { thread: there.id })
    await ui.until(() => pinned().join() === 'here', 'the archived one gone from Pinned')
    await ui.until(async () => (await appSetting('app.pins') as unknown[]).length === 1, 'and from the pins')
    await daemon.call('thread.unarchive', { thread: there.id })
    await ui.until(() => Boolean(rowOf('there')), 'unarchived, under its project')
    expect(pinned().join()).toBe('here')

    // The navigator lists the pinned first, marked, then the projects, the pinned again at their tops; a search finds it once.
    await ui.key('mod+l')
    await ui.until(() => Boolean($('.navigator__row')), 'the navigator')
    const first = $('.navigator__row')!
    expect(first.querySelector('.palette__title')?.textContent).toBe('here')
    expect(first.querySelector('.navigator__pin')).not.toBeNull()
    expect($$('.navigator__row--thread .palette__title').filter((t) => t.textContent === 'here')).toHaveLength(2)
    await ui.type('.palette__input', 'here')
    await ui.until(() => $$('.navigator__row--thread .palette__title').filter((t) => t.textContent === 'here').length === 1, 'found once')
    await ui.key('escape')
    await ui.until(() => !$('.navigator__row'), 'the navigator closed')

    // The sidebar hidden, the rail's dots show the pinned first.
    await ui.key('mod+/')
    await ui.until(() => dots(), 'the dots')
    expect($('.threads-rail__dot')!.getAttribute('aria-label')).toMatch(/^here,/)
    // Each once: not again with its project.
    expect($$('.threads-rail__dot').filter((dot) => dot.getAttribute('aria-label')?.startsWith('here,'))).toHaveLength(1)
  } finally {
    await ui?.unmount()
    await box.close()
  }
})

it('folds a thread\'s offshoots and a project, steps past them, keeps them folded, and unfolds the way to a thread selected', async () => {
  const elsewhere = join(daemon.dataDir, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  const parent = await daemon.thread(undefined, { title: 'parent', cwd: elsewhere })
  const offshoot = await daemon.call('thread.start', { cwd: elsewhere, title: 'offshoot', parent: parent.id }) as { id: string }
  await daemon.call('thread.send', { thread: offshoot.id, text: 'hello' })
  const here = await daemon.thread(undefined, { title: 'here' })
  ui = await mountUi({ window: true, extensions: [threads], machines: [daemon], select: { thread: here.id } })
  await ui.until(() => Boolean(rowOf('offshoot')?.classList.contains('threads-child')), 'the offshoot under its parent')
  const caret = (el: HTMLElement) => el.querySelector<HTMLElement>('.threads-caret')!
  expect(rowOf('here')!.querySelector('.threads-caret')).toBeNull()

  // Its caret folds the parent's offshoots: how many, and the most pressing of them (finished, unread), in its row.
  caret(rowOf('parent')!).click()
  await ui.until(() => !rowOf('offshoot'), 'the offshoot folded away')
  expect(titled()).toBe('here')
  expect(rowOf('parent')!.querySelector('.threads-tucked')?.textContent).toBe('1')
  await ui.until(() => Boolean(rowOf('parent')!.querySelector('.threads-tucked .superego-status--done')), 'its status, as the parent\'s')
  expect(JSON.parse(localStorage.getItem('superego.sidebar.folded')!)).toEqual([`thread:local/${parent.id}`])
  // Stepping goes past it.
  rowOf('parent')!.click()
  await ui.until(() => titled() === 'parent', 'the parent shown')
  await ui.key('mod+alt+arrowdown')
  await ui.until(() => titled() === 'here', 'past the folded offshoot, on to the next project')

  // → on the row unfolds, ← folds it again.
  rowOf('parent')!.focus()
  await ui.key('right')
  await ui.until(() => Boolean(rowOf('offshoot')), 'unfolded from the keyboard')
  await ui.key('left')
  await ui.until(() => !rowOf('offshoot'), 'folded from the keyboard')
  // Selected from elsewhere (here, as the navigator or a notification would), it unfolds the way to it.
  await ui.select({ thread: offshoot.id })
  await ui.until(() => Boolean(rowOf('offshoot')) && rowOf('parent')!.getAttribute('aria-expanded') === 'true', 'unfolded to the offshoot selected')

  // A project folds from its heading's caret, and from ← on its name; its threads out of sight, but the one selected.
  const section = rowOf('parent')!.closest('section')!
  caret(section.querySelector('.threads-project__head')!).click()
  await ui.until(() => section.classList.contains('is-folded'), 'the project folded')
  expect(rows().filter((li) => section.contains(li)).map((li) => li.querySelector('.threads__title')?.textContent)).toEqual(['offshoot'])
  expect(section.querySelector('.threads-project__head .threads-tucked')?.textContent).toBe('1')
  section.querySelector<HTMLElement>('.threads-project__name')!.focus()
  await ui.key('right')
  await ui.until(() => !section.classList.contains('is-folded') && Boolean(rowOf('parent')), 'unfolded from its name')

  // ⌘K: collapse every section, then expand everything.
  await ui.dispatch('threads.collapse')
  await ui.until(() => $$('.threads-project.is-folded').length === 2 && rows().length === 1, 'all folded, the selected one still shown')
  await ui.dispatch('threads.expand')
  await ui.until(() => !$('.threads-project.is-folded') && Boolean(rowOf('parent') && rowOf('offshoot') && rowOf('here')), 'all unfolded')
  expect(localStorage.getItem('superego.sidebar.folded')).toBeNull()
})

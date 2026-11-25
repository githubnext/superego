// @vitest-environment happy-dom
// Inspect mode (⌘⇧I): every view, slot, pane and space drawn is outlined; hovering one says what it is; clicking
// pastes its identifier into the thread's composer, or ⌥Click, or with no thread, copies it. Over a real daemon.
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineUiExtension } from '../src/renderer/extension-api.ts'
import { hueOf, measure, toggleInspect, rowsOf, sheetAt, type InspectInfo } from '../src/renderer/inspect.tsx'
import { fakeMachine, mountUi, testDaemon, testThread, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const boxes = () => $$('.inspect-box').map((b) => `${b.dataset.inspectKind}:${b.dataset.inspectId}`)

/** A view beside the thread, a slot above the composer, a pane kind and a space. */
const notes = defineUiExtension({
  name: 'notes',
  setup(superego) {
    superego.view('notes.view', { title: 'Notes', context: 'thread', fits: ['beside', 'pane'], component: () => 'the notes' })
    superego.slot('composer.above', () => createElement('span', null, 'a hint'))
    superego.pane('notes.pane', { title: 'A pane', component: () => 'in a pane' })
    superego.space('notes.board', { title: 'Board', component: () => createElement('div', null, 'a board') })
  },
})

let daemon: TestDaemon
let ui: TestWindow
let thread: string
beforeEach(async () => {
  // happy-dom lays nothing out: every element is 200×100 at a place of its own, so each region has a box to outline.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const at = [...document.querySelectorAll('*')].indexOf(this)
    return { x: 10, y: 10 + at, left: 10, top: 10 + at, right: 210, bottom: 110 + at, width: 200, height: 100, toJSON() {} } as DOMRect
  })
  daemon = await testDaemon({ model: 'echo' })
  thread = (await daemon.thread(undefined, { title: 'inspected' })).id
})
afterEach(async () => { toggleInspect(false); await ui?.unmount(); await daemon.close(); vi.restoreAllMocks(); localStorage.clear() })

const mount = async () => {
  ui = await mountUi({ window: true, extensions: [notes], machines: [daemon], select: { thread }, layout: { place: { 'notes.view': 'beside' } } })
  await ui.until(() => $('.thread__title')?.textContent === 'inspected' && Boolean($('.app__beside .placed-view')), 'the thread shown, the notes beside it')
}

it('turns on and off with its key, and Escape leaves it before anything under it hears', async () => {
  await mount()
  expect($('.inspect-layer')).toBeNull()
  await ui.key('mod+shift+i')
  await ui.until(() => Boolean($('.inspect-layer')), 'inspecting')
  expect($('.inspect-pill')?.textContent).toContain('Inspecting')
  await ui.key('escape')
  await ui.until(() => !$('.inspect-layer'), 'left with Escape')
  // No marker is left in what's drawn.
  expect($$('template[data-inspect-start], template[data-inspect-end]')).toHaveLength(0)
  await ui.key('mod+shift+i')
  await ui.until(() => Boolean($('.inspect-layer')), 'inspecting again')
  $('.inspect-pill__done')!.click()
  await ui.until(() => !$('.inspect-layer'), 'left with Done')
})

it('outlines the views and slots drawn, each by its extension', async () => {
  await mount()
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().length > 0, 'the outlines')
  expect(boxes()).toContain('view:notes.view')
  expect(boxes()).toContain('slot:composer.above')
  expect(boxes()).toContain('view:core.picker')
  const view = measure().find((b) => b.info.id === 'notes.view')!.info
  expect(view).toMatchObject({ kind: 'view', place: 'beside', fits: ['beside', 'pane'], context: 'thread', owner: { extension: 'notes' } })
  expect(measure().find((b) => b.info.id === 'composer.above')!.info).toMatchObject({ id: 'composer.above', owner: { extension: 'notes' } })
})

it('outlines a pane by its kind and a space by its own', async () => {
  const machine = fakeMachine({ threads: [testThread({ id: 'paned', title: 'paned', panes: [{ id: 'p1', kind: 'notes.pane', params: { page: 3 } }] })] })
  ui = await mountUi({ window: true, extensions: [notes], machines: [machine], select: { thread: 'paned' } })
  await ui.until(() => $('.thread__title')?.textContent === 'paned' && $$('.panes__column').length === 2, 'the pane')
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().includes('pane:notes.pane'), 'the pane outlined')
  expect(measure().find((b) => b.info.kind === 'pane')!.info).toMatchObject({ id: 'notes.pane', title: 'A pane', place: 'pane', params: { page: 3 }, owner: { extension: 'notes' } })
  toggleInspect(false)
  await ui.dispatch('space.open', { kind: 'notes.board', machine: 'local' })
  await ui.until(() => ui.space()?.kind === 'notes.board' && Boolean($('.space')), 'the space')
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().includes('space:notes.board'), 'the space outlined')
  expect(measure().find((b) => b.info.kind === 'space')!.info).toMatchObject({ id: 'notes.board', title: 'Board', place: 'main', owner: { extension: 'notes' } })
})

it('says what a region is when the pointer is over it', async () => {
  await mount()
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().includes('view:notes.view'), 'the outlines')
  const box = $('.inspect-box[data-inspect-id="notes.view"]')!
  expect($('.inspect-sheet')).toBeNull()
  box.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 30, clientY: 30 }))
  await ui.until(() => Boolean($('.inspect-sheet')), 'the sheet')
  const sheet = $('.inspect-sheet')!
  expect(sheet.querySelector('.inspect-sheet__title')?.textContent).toBe('Notes')
  expect(sheet.querySelector('.inspect-sheet__id')?.textContent).toBe('notes.view')
  const rows = Object.fromEntries($$('.inspect-sheet__rows > div').map((r) => [r.querySelector('dt')!.textContent, r.querySelector('dd')!.textContent]))
  expect(rows).toMatchObject({ Extension: 'notes', Kind: 'View', Place: 'beside', Fits: 'beside, pane', Context: 'thread' })
  expect(sheet.textContent).toContain('Click to paste in chat · ⌥Click to copy')
  expect($('.inspect-box.is-hovered')).toBe(box)
  box.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }))
  await ui.until(() => !$('.inspect-sheet'), 'the sheet gone')
})

it('pastes the identifier into the thread’s composer on a click, and leaves', async () => {
  await mount()
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().includes('view:notes.view'), 'the outlines')
  $('.inspect-box[data-inspect-id="notes.view"]')!.click()
  await ui.until(() => !$('.inspect-layer'), 'left')
  await ui.until(() => ($('textarea') as HTMLTextAreaElement | null)?.value === '`notes.view` ', 'the identifier in the draft')
  // A slot, after what's typed: with the extension that fills it.
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().includes('slot:composer.above'), 'the outlines')
  $('.inspect-box[data-inspect-id="composer.above"]')!.click()
  await ui.until(() => ($('textarea') as HTMLTextAreaElement | null)?.value === '`notes.view` `notes` (`composer.above`) ', 'the slot after it')
})

it('copies on ⌥Click, and stays', async () => {
  await mount()
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  document.execCommand = () => false
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().includes('view:notes.view'), 'the outlines')
  $('.inspect-box[data-inspect-id="notes.view"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
  await ui.until(() => copied.length === 1, 'copied')
  expect(copied).toEqual(['`notes.view`'])
  await ui.until(() => $('.inspect-pill')?.textContent?.includes('Copied') === true, 'the pill says so')
  expect($('.inspect-layer')).not.toBeNull()
  expect(($('textarea') as HTMLTextAreaElement | null)?.value).toBe('')
})

it('copies when no thread is open', async () => {
  ui = await mountUi({ window: true, extensions: [notes], machines: [daemon] })
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  document.execCommand = () => false
  await ui.key('mod+shift+i')
  await ui.until(() => boxes().length > 0, 'the outlines')
  const box = $('.inspect-box')!
  box.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await ui.until(() => $('.inspect-sheet__hint')?.textContent === 'Click to copy', 'the hint')
  box.click()
  await ui.until(() => copied.length === 1, 'copied')
})

it('tells a regions’s rows, colour and place without a window', () => {
  const owner = { extension: 'git', optional: true }
  const info: InspectInfo = { kind: 'pane', id: 'git.changes', title: 'Changes', owner, place: 'pane', params: { base: 'branch' } }
  const registry = { extensions: [{ name: 'git', version: '2.1.0' }] } as never
  expect(rowsOf(info, registry)).toEqual([['Extension', 'git · 2.1.0'], ['Kind', 'Pane'], ['Place', 'pane'], ['Params', '{"base":"branch"}']])
  expect(rowsOf({ ...info, owner: { extension: 'notes', optional: false, project: { machine: 'm', root: '/r', profile: 'chief' }, data: true } }, { extensions: [] } as never).slice(0, 3))
    .toEqual([['Extension', 'notes'], ['Kind', 'Pane · data'], ['Origin', 'Project profile · chief']])
  expect(hueOf('threads')).toBe(hueOf('threads'))
  expect(hueOf('threads')).not.toBe(hueOf('git'))
  const view = { width: 1000, height: 800 }
  const rect = { left: 400, top: 100, right: 500, bottom: 300 }
  // Beside the region, and inside the window at its edges.
  expect(sheetAt(rect, { width: 200, height: 100 }, { x: 0, y: 0 }, view)).toEqual({ left: 510, top: 100 })
  expect(sheetAt({ left: 700, top: 700, right: 990, bottom: 790 }, { width: 200, height: 100 }, { x: 0, y: 0 }, view).left).toBe(490)
  expect(sheetAt({ left: 0, top: 0, right: 1000, bottom: 800 }, { width: 200, height: 100 }, { x: 990, y: 790 }, view)).toEqual({ left: 792, top: 692 })
})

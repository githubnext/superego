// @vitest-environment happy-dom
// A project's spaces in the window drawn whole: a row each under the project's heading in the Threads sidebar, above its
// threads, opened in the Threads section (Threads stays lit; the rail has no buttons of its own for them).
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { h, defineUiExtension, NotebookIcon } from '@superego/app/ui'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const section = (name: string) => $$('.threads-project').find((s) => s.querySelector('.threads-project__name')?.textContent?.startsWith(name))
const threadsLit = () => $('.app__rail .threads-rail__button')?.classList.contains('is-on') === true
const litInRail = () => $$('.app__rail .app__rail-button.is-on')

/** A project's profile's UI: a board space. */
const board = defineUiExtension({
  name: 'board',
  setup(superego) {
    superego.space('board.main', { title: 'Board', icon: NotebookIcon, component: () => h('p', { className: 'board' }, 'The board'), entry: { lane: 'todo' } })
  },
})

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it("shows a project's spaces under its heading, opened in the Threads section", async () => {
  const base = await mkdtemp(join(tmpdir(), 'project-spaces-'))
  for (const name of ['shop', 'blog']) await mkdir(join(base, name, '.git'), { recursive: true })
  const shop = await daemon.thread('hello', { cwd: join(base, 'shop'), title: 'in the shop' })
  await daemon.thread('hello', { cwd: join(base, 'blog'), title: 'in the blog' })
  const root = shop.project.root
  ui = await mountUi({
    window: true, extensions: [threads], machines: [daemon], select: { thread: shop.id },
    profile: { ref: { scope: 'project', name: 'default', dir: join(root, '.superego', 'profiles', 'default') }, extensions: [board] },
  })
  await ui.until(() => Boolean(section('shop')?.querySelector('[data-space="board.main"]')), "the shop's board under its heading")
  const row = section('shop')!.querySelector<HTMLElement>('[data-space="board.main"]')!
  expect(row.textContent).toContain('▦')
  expect(row.textContent).toContain('Board')
  // Above the project's threads, and in no other project.
  expect(section('shop')!.querySelector('.threads-spaces')!.compareDocumentPosition(section('shop')!.querySelector('.threads__title')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(section('blog')!.querySelector('[data-space]')).toBeNull()
  // No buttons of their own in the rail.
  expect($('.app__rail [aria-label="Board"]')).toBeNull()

  // Its row opens it, with its entry params, in the project; Threads stays lit, alone, the row lit in it.
  row.click()
  await ui.until(() => Boolean($('.board')), 'the board in the main area')
  expect(ui.space()).toEqual({ machine: 'local', kind: 'board.main', params: { lane: 'todo' }, project: root })
  expect(threadsLit()).toBe(true)
  expect(litInRail()).toHaveLength(1)
  expect(section('shop')!.querySelector('[data-space="board.main"]')!.classList.contains('is-selected')).toBe(true)
  // Only the space is lit: not the thread it replaced.
  const threadRow = () => [...section('shop')!.querySelectorAll<HTMLElement>('.superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === 'in the shop')!
  expect(threadRow().classList.contains('is-selected')).toBe(false)
})

it("shows an app's space no sidebar holds alone: no sidebar, Threads unlit, back to the thread after", async () => {
  const notes = defineUiExtension({
    name: 'notes',
    setup(superego) { superego.space('notes.page', { title: 'Note', component: () => h('p', { className: 'note' }, 'A note') }) },
  })
  const first = await daemon.thread('hello', { title: 'first' })
  ui = await mountUi({ window: true, extensions: [threads, notes], machines: [daemon], select: { thread: first.id } })
  const row = () => $$('.threads-project .superego-list-item').find((li) => li.querySelector('.threads__title')?.textContent === 'first')
  await ui.until(() => row()?.classList.contains('is-selected') === true, 'the thread lit')
  await ui.dispatch('space.open', { kind: 'notes.page', params: {} })
  await ui.until(() => Boolean($('.note')), 'the note open')
  await ui.until(() => !$('.app__sidebar'), 'no sidebar')
  expect(threadsLit()).toBe(false)
  // Threads' button: its thread again, lit in its list.
  $('.app__rail .threads-rail__button')!.click()
  await ui.until(() => row()?.classList.contains('is-selected') === true, 'back to the thread')
  expect(ui.space()).toBeUndefined()
  await ui.dispatch('space.open', { kind: 'notes.page', params: {} })
  await ui.until(() => Boolean($('.note')), 'the note again')
  // Back to the thread, it's lit again.
  await ui.dispatch('thread.select', { machine: 'local', thread: first.id })
  await ui.until(() => row()?.classList.contains('is-selected') === true, 'lit again')
})

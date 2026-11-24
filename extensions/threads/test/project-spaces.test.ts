// @vitest-environment happy-dom
// A project's spaces in the window drawn whole: a row each under the project's heading in the Threads sidebar, above its
// threads; and in the rail, a group of their own while you're in the project (its thread selected, or one of its spaces
// open), gone once you leave it for another project's thread.
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
const railGroup = () => $('.app__rail .app__project-spaces')

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

it("shows a project's spaces under its heading and, while you're in it, in the rail", async () => {
  const base = await mkdtemp(join(tmpdir(), 'project-spaces-'))
  for (const name of ['shop', 'blog']) await mkdir(join(base, name, '.git'), { recursive: true })
  const shop = await daemon.thread('hello', { cwd: join(base, 'shop'), title: 'in the shop' })
  const blog = await daemon.thread('hello', { cwd: join(base, 'blog'), title: 'in the blog' })
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

  // In the rail while the shop's thread is selected: after the app's buttons, between lines.
  await ui.until(() => Boolean(railGroup()), 'the rail group')
  const button = railGroup()!.querySelector<HTMLElement>('[aria-label="Board"]')!
  expect(button.classList.contains('is-on')).toBe(false)
  expect(railGroup()!.previousElementSibling?.classList.contains('app__rail-sep')).toBe(true)
  expect(railGroup()!.nextElementSibling?.classList.contains('app__rail-sep')).toBe(true)

  // Its row opens it, with its entry params, in the project; lit in both places.
  row.click()
  await ui.until(() => Boolean($('.board')), 'the board in the main area')
  expect(ui.space()).toEqual({ machine: 'local', kind: 'board.main', params: { lane: 'todo' }, project: root })
  await ui.until(() => railGroup()?.querySelector('[aria-label="Board"]')?.classList.contains('is-on') === true, 'its rail button lit')
  expect(section('shop')!.querySelector('[data-space="board.main"]')!.classList.contains('is-selected')).toBe(true)

  // Another project's thread: out of the shop, the group goes.
  await ui.dispatch('thread.select', { machine: 'local', thread: blog.id })
  await ui.until(() => !railGroup(), 'the group gone in the blog')
  // Back in the shop, from its rail button too.
  await ui.dispatch('thread.select', { machine: 'local', thread: shop.id })
  await ui.until(() => Boolean(railGroup()), 'the group back')
  railGroup()!.querySelector<HTMLElement>('[aria-label="Board"]')!.click()
  await ui.until(() => ui.space()?.kind === 'board.main', 'opened from the rail')
})

it("puts them at a phone's drawer foot while you're in the project, apart", async () => {
  const base = await mkdtemp(join(tmpdir(), 'project-spaces-'))
  await mkdir(join(base, 'shop', '.git'), { recursive: true })
  const shop = await daemon.thread('hello', { cwd: join(base, 'shop'), title: 'in the shop' })
  ui = await mountUi({
    window: true, extensions: [threads], machines: [daemon], select: { thread: shop.id }, narrow: true,
    profile: { ref: { scope: 'project', name: 'default', dir: join(shop.project.root, '.superego', 'profiles', 'default') }, extensions: [board] },
  })
  await ui.until(() => Boolean($('.app.is-narrow .app__mobilebar')), 'the narrow layout')
  $('.app__mobilebar button')!.click()
  await ui.until(() => Boolean($('.app__drawer .app__drawer-bar .app__project-spaces [aria-label="Board"]')), "the board at the drawer's foot")
  expect($('.app__drawer .app__drawer-bar .app__project-spaces')!.previousElementSibling?.classList.contains('app__drawer-sep')).toBe(true)
})

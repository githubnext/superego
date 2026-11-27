// @vitest-environment happy-dom
// The rail picks the whole window: each sidebar's button shows its section, the sidebar and what it holds in the main
// area, as it was left; one button lit at a time. Threads holds threads; Notes (its extension declares a space) its
// notes; Staff (a sidebar with no spaces) threads of its own; Vault's rail button a space no sidebar holds, alone.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { h, defineUiExtension, RailButton, useSpace, type ViewProps } from '@superego/app/ui'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import threads from '../src/ui.tsx'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
/** The rail's buttons lit, by label. */
const lit = () => $$('.app__rail .app__rail-button.is-on').map((b) => b.getAttribute('aria-label'))
const rail = (label: string) => $(`.app__rail [aria-label="${label}"]`)!
const sidebar = () => $('.app__sidebar')?.getAttribute('data-sidebar')
/** The title bar's title: the thread's (or the space's) shown. */
const title = () => $('.app__titlebar .titlebar__title')?.textContent ?? ''
const main = () => $('.app__main')?.textContent ?? ''

const notes = defineUiExtension({
  name: 'notes',
  setup(superego) {
    superego.view('notes.list', { title: 'Notes', context: 'window', fits: ['sidebar'], default: 'sidebar', component: () => h('p', null, 'the notes') })
    superego.space('notes.page', { title: (p) => String(p.name), component: ({ params }) => h('p', { className: 'note' }, `note ${String(params.name)}`) })
  },
})
const staff = defineUiExtension({
  name: 'staff',
  setup(superego) {
    superego.view('staff.list', { title: 'Staff', context: 'window', fits: ['sidebar'], default: 'sidebar', component: () => h('p', null, 'the leads') })
  },
})
const vault = defineUiExtension({
  name: 'vault',
  setup(superego) {
    superego.space('vault.space', { title: 'Vault', component: () => h('p', { className: 'vault' }, 'the vault') })
    superego.view('vault.rail', {
      title: 'Vault', context: 'window', fits: ['rail'], default: 'rail',
      component: function VaultButton(_props: ViewProps<'window'>) {
        const { space } = useSpace()
        return h(RailButton, { label: 'Vault', on: space?.kind === 'vault.space', onClick: () => void superego.dispatch('space.open', { kind: 'vault.space' }) }, 'V')
      },
    })
  },
})

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('shows a whole section per rail button, as it was left, one lit', async () => {
  const a = await daemon.thread('hello', { title: 'thread a' })
  const lead = await daemon.thread('hello', { title: 'the lead' })
  ui = await mountUi({ window: true, extensions: [threads, notes, staff, vault], machines: [daemon], select: { thread: a.id } })
  await ui.until(() => title().includes('thread a'), 'thread a shown')
  expect(lit()).toEqual(['Threads'])
  expect(sidebar()).toBe('threads.list')

  // Notes: its list, and nothing of the thread's in the main area until a note's open.
  rail('Notes').click()
  await ui.until(() => sidebar() === 'notes.list', "Notes' list")
  expect(lit()).toEqual(['Notes'])
  expect(main()).toContain('Nothing open in Notes.')
  expect(title()).not.toContain('thread a')
  expect($('.app__main .thread')).toBeNull()
  await ui.dispatch('space.open', { kind: 'notes.page', params: { name: 'ideas' } })
  await ui.until(() => Boolean($('.note')), 'the note')

  // Threads again: the thread it had; Notes again: the note.
  rail('Threads').click()
  await ui.until(() => title().includes('thread a'), 'thread a again')
  expect(lit()).toEqual(['Threads'])
  rail('Notes').click()
  await ui.until(() => $('.note')?.textContent === 'note ideas', 'the note again')
  expect(lit()).toEqual(['Notes'])

  // A thread shown from a note goes to the thread section last shown: Threads.
  await ui.select({ thread: a.id })
  await ui.until(() => sidebar() === 'threads.list', 'in Threads')

  // Staff: a thread section of its own, empty until a thread's picked there.
  rail('Staff').click()
  await ui.until(() => sidebar() === 'staff.list', "Staff's list")
  expect(main()).toContain('Select or start a thread.')
  await ui.select({ thread: lead.id })
  await ui.until(() => title().includes('the lead'), 'the lead shown')
  expect(lit()).toEqual(['Staff'])
  rail('Threads').click()
  await ui.until(() => title().includes('thread a'), 'Threads keeps its own')
  rail('Staff').click()
  await ui.until(() => title().includes('the lead'), 'and Staff its own')

  // Vault: its space alone, no sidebar, only its button lit; Back to where it was.
  rail('Vault').click()
  await ui.until(() => Boolean($('.vault')), 'the vault')
  expect(sidebar()).toBeUndefined()
  expect(lit()).toEqual(['Vault'])
  await ui.dispatch('app.back')
  await ui.until(() => title().includes('the lead') && sidebar() === 'staff.list', 'back in Staff')
  expect(lit()).toEqual(['Staff'])
})

it("switches the section from a phone's drawer foot, the drawer open on its list", async () => {
  const a = await daemon.thread('hello', { title: 'thread a' })
  ui = await mountUi({ window: true, extensions: [threads, notes], machines: [daemon], select: { thread: a.id }, narrow: true })
  await ui.until(() => Boolean($('.app.is-narrow .app__mobilebar')), 'the narrow layout')
  $('.app__mobilebar button')!.click()
  await ui.until(() => Boolean($('.app__drawer .app__drawer-bar [aria-label="Notes"]')), "Notes at the drawer's foot")
  $('.app__drawer .app__drawer-bar [aria-label="Notes"]')!.click()
  await ui.until(() => $('.app__drawer .app__sidebar')?.getAttribute('data-sidebar') === 'notes.list', "the drawer on Notes' list")
  await ui.until(() => main().includes('Nothing open in Notes.'), "Notes' main area")
})

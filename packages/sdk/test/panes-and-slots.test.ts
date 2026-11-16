// superego/testing's window drawing a pane kind and a slot, as the window would: by the registry's own lookups, so a kind
// or slot the window wouldn't draw for that thread fails here too.
import { createElement as h } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { defineUiExtension, type PaneProps, type SlotProps, type ViewProps } from '../src/ui.ts'
import { fakeMachine, mountUi, testThread, type TestWindow } from '../src/testing.ts'

const open: TestWindow[] = []
const keep = (ui: TestWindow) => { open.push(ui); return ui }
afterEach(async () => { for (const ui of open.splice(0).reverse()) await ui.unmount() })

const opened: string[] = []
const board = defineUiExtension({
  name: 'board',
  setup(superego) {
    superego.pane('board.card', {
      title: 'Card',
      component: ({ thread, pane }: PaneProps) => h('div', null,
        h('p', null, `${(pane.params as { card: string }).card} in ${thread.title}`),
        h('button', { type: 'button', onClick: () => opened.push((pane.params as { card: string }).card) }, 'Open')),
    })
    superego.view('board.columns', {
      title: 'Columns', context: 'thread', fits: ['beside', 'pane'], default: 'beside',
      component: ({ thread }: ViewProps<'thread'>) => h('p', null, `Columns of ${thread.id}`),
    })
    superego.slot('thread.badge', ({ thread }: SlotProps['thread.badge']) =>
      thread.cwd.endsWith('/db') ? h('span', { className: 'thread-badge', title: 'database' }, 'DB') : null)
    superego.slot('editor.bar', ({ path }: SlotProps['editor.bar']) => h('button', { type: 'button' }, `Lint ${path}`))
  },
})

describe('rendering a pane kind', () => {
  it('draws it with its params for the thread given, and its buttons work', async () => {
    const ui = keep(await mountUi({ extensions: [board], machines: [fakeMachine({ threads: [testThread({ id: 't1', title: 'Planning' })] })] }))
    const pane = await ui.render({ pane: { kind: 'board.card', params: { card: 'Ship it' } }, thread: 't1' })
    expect(pane.text()).toContain('Ship it in Planning')
    await pane.click('Open')
    expect(opened).toEqual(['Ship it'])
    // A thread view that fits a pane is a pane kind of its id; without a thread, the machine's first.
    expect((await ui.render({ pane: { kind: 'board.columns' } })).text()).toBe('Columns of t1')
  })

  it("throws for a kind the thread doesn't have, saying which it has", async () => {
    const ui = keep(await mountUi({ extensions: [board] }))
    await expect(ui.render({ pane: { kind: 'board.cards' } })).rejects.toThrow(/No pane kind board.cards in thread test: .*board.card/)
    // A thread that goes without the extension has none of its kinds.
    await expect(ui.render({ pane: { kind: 'board.card' }, thread: testThread({ without: ['board'] }) })).rejects.toThrow(/No pane kind board.card/)
  })

  it('draws it only for machines that run the extension at the major its UI half speaks', async () => {
    const v2 = { ...board, version: '2.0.0' }
    // Named alone, a fake machine's extension is at the version mounted.
    const same = keep(await mountUi({ extensions: [v2], machines: [fakeMachine({ extensions: ['board'] })] }))
    expect((await same.render({ pane: { kind: 'board.card', params: { card: 'A' } } })).text()).toContain('A in')
    await same.unmount(); open.pop()
    const older = keep(await mountUi({ extensions: [v2], machines: [fakeMachine({ extensions: [{ name: 'board', version: '1.3.0' }] })] }))
    await expect(older.render({ pane: { kind: 'board.card' } })).rejects.toThrow(/No pane kind board.card/)
  })

  it("draws a profile's kind only in that profile's threads", async () => {
    const ref = { scope: 'user' as const, name: 'kanban', dir: '/profiles/kanban' }
    const ui = keep(await mountUi({ profile: { ref, extensions: [board] } }))
    // No thread given and none on the machine: one of the profile's, made up.
    expect((await ui.render({ pane: { kind: 'board.card', params: { card: 'A' } } })).text()).toContain('A in Thread test')
    await expect(ui.render({ pane: { kind: 'board.card' }, thread: testThread() })).rejects.toThrow(/give a thread of that profile/)
  })
})

describe('rendering a slot', () => {
  it('draws what fills it for the thread given, as that thread is', async () => {
    const ui = keep(await mountUi({ extensions: [board] }))
    const badge = await ui.render({ slot: 'thread.badge', thread: testThread({ cwd: '/work/db' }) })
    expect(badge.find('.thread-badge')?.title).toBe('database')
    expect((await ui.render({ slot: 'thread.badge', thread: testThread({ cwd: '/work/web' }) })).text()).toBe('')
    expect((await ui.render({ slot: 'editor.bar', props: { path: 'a.ts' } })).text()).toBe('Lint a.ts')
  })

  it("throws for a slot nothing fills for the thread, or one that's a place now", async () => {
    const ui = keep(await mountUi({ extensions: [board] }))
    await expect(ui.render({ slot: 'details.section' })).rejects.toThrow(/Nothing fills details.section/)
    await expect(ui.render({ slot: 'thread.badge', thread: testThread({ without: ['board'] }) })).rejects.toThrow(/1 elsewhere/)
    await expect(ui.render({ slot: 'sidebar' as never })).rejects.toThrow(/No slot sidebar/)
  })
})

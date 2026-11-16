// superego/testing, as an author uses it: a daemon with a scripted model, a window over fakes or that daemon, and the
// cases an extension has to survive: teardown, being set up twice, a helper edited, one profile on two machines, a
// machine gone or older, and a phone with no spaces.
import { createElement as h } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { defineDaemonExtension } from '../src/index.ts'
import { defineAction, defineUiExtension, usePlacement, useValue, type ViewProps } from '../src/ui.ts'
import { callTool, fakeMachine, mountUi, say, testDaemon, testThread, type TestDaemon, type TestWindow } from '../src/testing.ts'

const open: (TestDaemon | TestWindow)[] = []
const keep = <T extends TestDaemon | TestWindow>(it: T) => { open.push(it); return it }
afterEach(async () => {
  for (const it of open.splice(0).reverse()) await ('peer' in it ? it.close() : it.unmount())
})

/** A profile with a tool that queues work per thread, a scoped value of the queue, and a data view of it. */
const PROFILE = {
  'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./queue.ts'] })\n`,
  'label.ts': `export const label = 'first'\n`,
  'queue.ts': `import { defineDaemonExtension, defineExtension, defineTool, obj, str } from 'superego'
import { label } from './label.ts'
export default defineDaemonExtension({
  name: 'queue', version: '1.0.0', api: '^2',
  setup(superego) {
    const queue = superego.scopedValue('queue.items', { items: [], empty: 'Nothing queued.' })
    superego.method('queue.label', () => label)
    superego.agent(defineExtension({ name: 'queue', tools: [defineTool({
      name: 'enqueue', description: 'Queue work.', parameters: obj({ what: str() }),
      async execute({ what }, api) {
        const thread = superego.threads.of(api.conversationId)
        queue.update(thread, (view) => ({ ...view, items: [...view.items, { title: what }] }))
        return { output: [{ type: 'text', text: 'Queued ' + what }] }
      },
    })] }))
    superego.view('queue.list', { title: 'Queue', context: 'thread', fits: ['beside', 'pane'], default: 'beside', value: 'queue.items' })
    globalThis.__queueSetUps = (globalThis.__queueSetUps ?? 0) + 1
    superego.signal.addEventListener('abort', () => { globalThis.__queueTornDown = (globalThis.__queueTornDown ?? 0) + 1 })
  },
})
`,
}
const g = globalThis as { __queueSetUps?: number; __queueTornDown?: number }

describe('a daemon with a scripted model', () => {
  it("runs the profile's tool, publishes the thread's own queue, and tears it down when a helper changes", async () => {
    const daemon = keep(await testDaemon({ profile: PROFILE, model: [callTool('enqueue', { what: 'lint' }), say('Queued it.')] }))
    const thread = await daemon.thread('Queue a lint')
    expect(await daemon.transcript(thread.id)).toContain('Queued it.')
    const queue = await daemon.watch<{ items: { title: string }[] }>('queue.items', { scope: thread.id })
    expect(queue.value.items).toEqual([{ title: 'lint' }])
    expect(await daemon.call('queue.label')).toBe('first')
    expect(daemon.features).toContain('ext:queue')
    // A helper edited alone: the profile loads again, its extension torn down and set up anew with the new code.
    const before = { setUps: g.__queueSetUps ?? 0, torn: g.__queueTornDown ?? 0 }
    await daemon.edit('label.ts', `export const label = 'second'\n`)
    await daemon.reload()
    expect(await daemon.call('queue.label')).toBe('second')
    expect(g.__queueTornDown).toBe(before.torn + 1)
    expect(g.__queueSetUps).toBe(before.setUps + 1)
    // The value is the new set-up's: it starts empty.
    await queue.until((view) => view.items.length === 0, 'the queue to start over')
  })

  it('refuses a second extension of the same name, and keeps the first', async () => {
    const one = defineDaemonExtension({ name: 'twice', setup(superego) { superego.method('twice.which', () => 'first') } })
    const two = defineDaemonExtension({ name: 'twice', setup(superego) { superego.method('twice.which', () => 'second') } })
    await expect(testDaemon({ extensions: [one, two] })).rejects.toThrow(/already set up/)
  })

  it('keeps threads and state across a restart, with a new script', async () => {
    const first = await testDaemon({ profile: PROFILE, model: [say('Hello.')] })
    const thread = await first.thread('hi')
    const second = keep(await first.restart({ model: [say('Again.')] }))
    await second.send(thread.id, 'once more')
    expect(await second.transcript(thread.id)).toContain('Again.')
  })
})

/** A UI half: the queue beside the thread, with a button to clear it, and ⌘⇧Q to show it. */
const cleared: string[] = []
let tornDown = 0
const queueUi = defineUiExtension({
  name: 'queue', version: '1.0.0', api: '^2',
  setup(superego) {
    superego.view('queue.list', {
      title: 'Queue', context: 'thread', fits: ['beside', 'pane'], default: 'beside',
      component: ({ machine, thread }: ViewProps<'thread'>) => {
        const items = useValue<string[]>(machine, 'queue.items', { scope: thread.id })
        if (machine.state !== 'connected') return h('p', null, `${machine.label} is away.`)
        return h('div', null, h('p', null, items?.length ? items.join(', ') : 'Nothing queued.'),
          h('button', { type: 'button', onClick: () => void superego.dispatch('queue.clear', { id: thread.id }, { machine: machine.id }) }, 'Clear'))
      },
    })
    superego.action(defineAction({ id: 'queue.show', title: 'Show the queue', keys: 'mod+shift+q', run: () => { cleared.push('shown') } }))
    superego.signal.addEventListener('abort', () => { tornDown++ })
  },
})

describe('a window for a UI half', () => {
  it('draws a view from a fake machine, and its button calls the machine', async () => {
    const thread = testThread({ id: 't1' })
    const machine = fakeMachine({
      extensions: ['queue'], threads: [thread], values: { 'queue.items': { t1: ['lint', 'test'], t2: ['other'] } },
      methods: { 'queue.clear': ({ id }: { id: string }) => { cleared.push(id); machine.setValue('queue.items', [], id) } },
    })
    const ui = keep(await mountUi({ extensions: [queueUi], machines: [machine], select: { thread: 't1' } }))
    expect(ui.placed('beside', { thread: 't1' })).toContain('queue.list')
    const beside = await ui.render({ view: 'queue.list', place: 'beside', thread: 't1' })
    expect(beside.text()).toContain('lint, test')
    // Only this thread's scope was asked for.
    expect(machine.calls).toEqual([])
    await beside.click('Clear')
    expect(cleared).toEqual(['t1'])
    expect(beside.text()).toContain('Nothing queued.')
    expect(await ui.press('mod+shift+q')).toBe('queue.show')
  })

  it("tears its extensions down when it's unmounted: their signals abort", async () => {
    const ui = await mountUi({ extensions: [queueUi] })
    const before = tornDown
    await ui.unmount()
    expect(tornDown).toBe(before + 1)
  })

  it("replaces a profile's UI installed again: the first torn down, nothing drawn twice", async () => {
    const ref = { scope: 'user' as const, name: 'default', dir: '/profiles/default' }
    const thread = testThread({ id: 't1', profile: ref })
    const ui = keep(await mountUi({ machines: [fakeMachine({ threads: [thread], values: { 'queue.items': { t1: ['lint'] } } })], profile: { ref, extensions: [queueUi] } }))
    const before = tornDown
    await ui.installProfile('local', ref, [queueUi])
    expect(tornDown).toBe(before + 1)
    const beside = await ui.render({ place: 'beside', thread: 't1' })
    expect(beside.text().match(/lint/g)).toHaveLength(1)
    // Not in another thread: a profile's UI is its own threads'.
    expect(ui.placed('beside', { thread: 't1' })).toContain('queue.list')
  })

  it("keeps an extension's stores under its name, given bare or already named", async () => {
    const kanban = defineUiExtension({
      name: 'kanban',
      setup(superego) {
        superego.store<string[]>('columns', ['todo'], { persist: true }).set(['todo', 'done'])
        superego.store<boolean>('kanban.folded', false, { persist: true }).set(true)
      },
    })
    const stored = () => Object.keys(localStorage).filter((key) => key.includes('kanban')).sort()
    const bundled = await mountUi({ extensions: [kanban] })
    expect(stored()).toEqual(['superego.kanban.columns', 'superego.kanban.folded'])
    await bundled.unmount()
    // A profile's the same, kept apart for that profile.
    const ref = { scope: 'user' as const, name: 'default', dir: '/profiles/default' }
    keep(await mountUi({ profile: { ref, extensions: [kanban] } }))
    expect(stored()).toHaveLength(2)
    for (const key of stored()) expect(key).toMatch(/^superego\.profile\..+\.kanban\.(columns|folded)$/)
  })

  it("fails on a profile's UI that fails to start, where the window would go on without it", async () => {
    const ref = { scope: 'user' as const, name: 'default', dir: '/profiles/default' }
    const broken = defineUiExtension({ name: 'broken', setup() { throw new Error('no columns') } })
    const errors = console.error
    console.error = () => {}
    try {
      await expect(mountUi({ profile: { ref, extensions: [broken] } })).rejects.toThrow('no columns')
      const ui = keep(await mountUi({ profile: { ref, extensions: [] } }))
      await expect(ui.installProfile('local', ref, [broken])).rejects.toThrow('no columns')
    } finally { console.error = errors }
  })

  it('says a machine is away, and copes with an older one that watches values whole', async () => {
    const thread = testThread({ id: 't1' })
    const older = fakeMachine({ features: ['threads', 'actions', 'data-views'], extensions: [{ name: 'queue', version: '0.9.0' }], threads: [thread], values: { 'queue.items': { t1: ['old'], t2: ['x'] } } })
    const ui = keep(await mountUi({ extensions: [queueUi], machines: [older] }))
    const beside = await ui.render({ view: 'queue.list', place: 'beside', thread: 't1' })
    expect(beside.text()).toContain('old')
    expect(beside.text()).not.toContain('x')
    await ui.setMachine('local', { state: 'disconnected' })
    expect(beside.text()).toContain('local is away.')
  })

  it('reads and changes a view declared on two machines as the thread it is drawn for has it', async () => {
    // One profile on two machines, its notes beside the thread on the box and in the header on the laptop.
    const ref = { scope: 'user' as const, name: 'default', dir: '/profiles/default' }
    const a = testThread({ id: 'a', profile: ref }), b = testThread({ id: 'b', profile: ref })
    const notes = (place: 'beside' | 'header', name: string) => defineUiExtension({
      name: 'notes', setup(superego) {
        superego.view('notes.list', { title: 'Notes', context: 'thread', fits: ['beside', 'header'], default: place, component: () => {
          const [on, toggle] = usePlacement('notes.list', place)
          return h('button', { type: 'button', onClick: () => toggle() }, `${name}:${on}`)
        } })
      },
    })
    const ui = keep(await mountUi({ machines: [fakeMachine({ id: 'box', threads: [a] }), fakeMachine({ id: 'laptop', threads: [b] })], select: { machine: 'box', thread: 'a' } }))
    await ui.installProfile('box', ref, [notes('beside', 'BOX')])
    await ui.installProfile('laptop', ref, [notes('header', 'LAPTOP')])
    const box = await ui.render({ place: 'beside', machine: 'box', thread: 'a' })
    const laptop = await ui.render({ place: 'header', machine: 'laptop', thread: 'b' })
    // The probe that read BOX:false: the hook reads the place as its thread's is drawn, not the window's.
    expect(box.text()).toBe('BOX:true')
    expect(laptop.text()).toBe('LAPTOP:true')
    // Toggled in the laptop's header, with the box's thread selected: worked out from the laptop's declaration, it
    // hides (it was put beside the thread and in the header, as the box's said). Kept by id, so it's hidden in every thread.
    await laptop.click('LAPTOP:true')
    expect(ui.placed('header', { machine: 'laptop', thread: 'b' })).toEqual([])
    expect(ui.placed('beside', { machine: 'box', thread: 'a' })).toEqual([])
    expect(laptop.text()).toBe('')
    // Moved there from the laptop's header (back where it was first): beside its thread, out of its header.
    await ui.dispatch('layout.place', { view: 'notes.list', place: 'header', on: true, machine: 'laptop', thread: 'b' })
    expect(ui.placed('header', { machine: 'laptop', thread: 'b' })).toEqual(['notes.list'])
    await ui.dispatch('layout.place', { view: 'notes.list', place: 'beside', from: 'header', machine: 'laptop', thread: 'b' })
    expect(ui.placed('beside', { machine: 'laptop', thread: 'b' })).toEqual(['notes.list'])
    expect(ui.placed('header', { machine: 'laptop', thread: 'b' })).toEqual([])
    expect(ui.placed('beside', { machine: 'box', thread: 'a' })).toEqual(['notes.list'])
    // Without a thread named (⌘I's way), the selected one's: the laptop's thread, its header toggled on.
    await ui.select({ machine: 'laptop', thread: 'b' })
    await ui.dispatch('layout.place', { view: 'notes.list', place: 'header' })
    expect(ui.placed('header', { machine: 'laptop', thread: 'b' })).toEqual(['notes.list'])
    await expect(ui.dispatch('layout.place', { view: 'notes.list', place: 'beside', machine: 'laptop', thread: 'gone' })).rejects.toThrow('No thread gone on laptop')
  })

  it('places views on a phone with no spaces: nothing in a rail, the thread picker in the bar', async () => {
    const ui = keep(await mountUi({ extensions: [queueUi], narrow: true }))
    expect(ui.placed('space')).toEqual([])
    expect(ui.placed('titlebar')).toContain('core.picker')
  })
})

describe('a window on test daemons', () => {
  it('shows one profile on two machines, each thread its own machine\'s queue', async () => {
    const box = keep(await testDaemon({ profile: PROFILE, model: [callTool('enqueue', { what: 'on box' }), say('ok')] }))
    const laptop = keep(await testDaemon({ profile: PROFILE, model: [callTool('enqueue', { what: 'on laptop' }), say('ok')] }))
    const a = await box.thread('queue')
    const b = await laptop.thread('queue')
    const { daemonMachine } = await import('../src/testing.ts')
    const ui = keep(await mountUi({ machines: [daemonMachine(box, 'box'), daemonMachine(laptop, 'laptop')] }))
    // The data view the profile declares, drawn by the window: once in each thread, from its own machine.
    expect(ui.placed('beside', { machine: 'box', thread: a.id })).toEqual(['queue.list'])
    const onBox = await ui.render({ place: 'beside', machine: 'box', thread: a.id })
    const onLaptop = await ui.render({ place: 'beside', machine: 'laptop', thread: b.id })
    await ui.settle()
    expect(onBox.text()).toContain('on box')
    expect(onBox.text()).not.toContain('on laptop')
    expect(onLaptop.text()).toContain('on laptop')
  })
})


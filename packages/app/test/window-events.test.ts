// Window lifecycle hooks: what extensions hear through `superego.on`, owned by the extension and gone with it, and the
// status changes the shell works out from each machine's threads.
import { describe, expect, it } from 'vitest'
import { defineApp, type Status, type ThreadInfo } from '@superego/protocol'
import { createRegistry, defineUiExtension, slotEntries, type WindowEvents } from '../src/renderer/extension.tsx'
import { rejectionChanges, statusChanges, type Statuses } from '../src/renderer/window-events.ts'

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'default', dir: '/home/me/.superego/profiles/default' }
const thread = (id: string, state: Status['state'], more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id, title: id, cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state }, ...more,
})

/** An extension that writes down what it hears. */
const listening = (name: string, heard: string[], more: Partial<{ required: boolean }> = {}) => defineUiExtension({
  name, ...more,
  setup(superego) {
    superego.on('thread.status', ({ machine, thread, before }) => heard.push(`${name}: ${machine}/${thread.id} ${before ?? 'new'}→${thread.status.state}`))
    superego.on('select', ({ selection }) => heard.push(`${name}: shows ${selection?.thread ?? 'nothing'}`))
    superego.on('focus', ({ focused }) => heard.push(`${name}: ${focused ? 'focused' : 'blurred'} (${superego.window.focused})`))
  },
})

describe('window events', () => {
  it('tells listeners what happened, with the window as it is now', () => {
    const heard: string[] = []
    const registry = createRegistry(app, [listening('bell', heard)], () => {})
    registry.emit('thread.status', { machine: 'local', thread: thread('a', 'done'), before: 'working' })
    registry.emit('select', { selection: { machine: 'local', thread: 'a' }, before: undefined })
    registry.emit('focus', { focused: false })
    expect(heard).toEqual(['bell: local/a working→done', 'bell: shows a', 'bell: blurred (false)'])
    expect(registry.window.selection).toEqual({ machine: 'local', thread: 'a' })
  })

  it("leaves out an optional extension's listeners for a thread that goes without it, and a profile's for others' threads", () => {
    const heard: string[] = []
    const registry = createRegistry(app, [listening('bell', heard), listening('sidebar', heard, { required: true })], () => {})
    registry.installProfile('local', profile, [listening('mine', heard)])
    registry.emit('thread.status', { machine: 'local', thread: thread('a', 'done', { without: ['bell', 'sidebar'] }), before: 'working' })
    registry.emit('thread.status', { machine: 'local', thread: thread('b', 'done', { profile }), before: 'working' })
    expect(heard).toEqual(['sidebar: local/a working→done', 'bell: local/b working→done', 'sidebar: local/b working→done', 'mine: local/b working→done'])
  })

  it('stops listening at teardown, or when told to', () => {
    const heard: string[] = []
    const registry = createRegistry(app, [], () => {})
    registry.installProfile('local', profile, [listening('mine', heard)])
    registry.installProfile('local', profile, [])
    let off = () => {}
    createRegistry(app, [defineUiExtension({ name: 'once', setup(superego) { off = superego.on('focus', () => heard.push('once')) } })], () => {})
    off()
    registry.emit('focus', { focused: true })
    expect(heard).toEqual([])
    expect(registry.listeners).toHaveLength(0)
  })

  it('goes on to the next listener when one throws', () => {
    const heard: string[] = []
    const thrower = defineUiExtension({ name: 'thrower', setup(superego) { superego.on('focus', () => { throw new Error('no') }) } })
    const registry = createRegistry(app, [thrower, listening('bell', heard)], () => {})
    const error = console.error
    console.error = () => {}
    try { registry.emit('focus', { focused: true }) } finally { console.error = error }
    expect(heard).toEqual(['bell: focused (true)'])
  })
})

describe('status changes', () => {
  it('says which threads changed state, and first sightings with no before', () => {
    const before: Statuses = new Map()
    const first = statusChanges(before, { local: [thread('a', 'working'), thread('b', 'idle')], box: undefined })
    expect(first.map((e) => [e.thread.id, e.before])).toEqual([['a', undefined], ['b', undefined]])
    expect(statusChanges(before, { local: [thread('a', 'working'), thread('b', 'idle')] })).toEqual([])
    const next: WindowEvents['thread.status'][] = statusChanges(before, { local: [thread('a', 'done'), thread('b', 'idle')] })
    expect(next.map((e) => [e.machine, e.thread.id, e.before, e.thread.status.state])).toEqual([['local', 'a', 'working', 'done']])
  })

  it("forgets threads gone from their machine's list, and keeps a machine's while it has no list", () => {
    const before: Statuses = new Map()
    statusChanges(before, { local: [thread('a', 'done')], box: [thread('far', 'working')] })
    statusChanges(before, { local: [], box: undefined })
    expect([...before.keys()]).toEqual(['box/far'])
    // Back again (unarchived): seen anew.
    expect(statusChanges(before, { local: [thread('a', 'done')] })[0]!.before).toBeUndefined()
  })
})

describe('fallback slots', () => {
  it('draws a fallback only while nothing else fills the slot', () => {
    const Bell = () => null
    const Spaces = () => null
    const bell = defineUiExtension({ name: 'bell', setup(superego) { superego.slot('rail', Bell, { fallback: true }) } })
    const spaces = defineUiExtension({ name: 'spaces', setup(superego) { superego.slot('rail', Spaces) } })
    expect(slotEntries(createRegistry(app, [bell], () => {}), 'rail', undefined).map((e) => e.component)).toEqual([Bell])
    expect(slotEntries(createRegistry(app, [bell, spaces], () => {}), 'rail', undefined).map((e) => e.component)).toEqual([Spaces])
    // A button that's always there doesn't fill it.
    const Ego = () => null
    const ego = defineUiExtension({ name: 'ego', setup(superego) { superego.slot('rail', Ego, { order: 10, fills: false }) } })
    expect(slotEntries(createRegistry(app, [bell, ego], () => {}), 'rail', undefined).map((e) => e.component)).toEqual([Ego, Bell])
    expect(slotEntries(createRegistry(app, [bell, ego, spaces], () => {}), 'rail', undefined).map((e) => e.component)).toEqual([Ego, Spaces])
  })
})

describe('rejectionChanges', () => {
  const rejection = (provider: string, since: number, threads: string[] = []) => ({ provider, name: provider, summary: `${provider} rejected the API key`, detail: '401', since, threads })

  it('tells of a provider rejected on a machine already heard from, once, and again when it is rejected anew', () => {
    const before = new Map()
    // What a machine had when the window first heard isn't news; a machine yet to say is skipped.
    expect(rejectionChanges(before, { local: [rejection('anthropic', 1)], box: undefined })).toEqual([])
    expect(rejectionChanges(before, { local: [rejection('anthropic', 1, ['a', 'b'])] })).toEqual([])
    expect(rejectionChanges(before, { box: [] })).toEqual([])
    expect(rejectionChanges(before, { box: [rejection('openai', 2, ['c'])] })).toEqual([{ machine: 'box', rejection: rejection('openai', 2, ['c']) }])
    expect(rejectionChanges(before, { box: [] })).toEqual([])
    expect(rejectionChanges(before, { local: [rejection('anthropic', 3)] })).toEqual([{ machine: 'local', rejection: rejection('anthropic', 3) }])
  })
})

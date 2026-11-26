// The composer's own commands: a message that is one (`/clear`, `/new`, `/compact`, with what follows), what a `/` opening the
// message offers, where they're taken; and what a thread started in another's place takes after it.
import { describe, expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { commandAt, commandCompletions, commandIn, commandsFor, takes } from '../src/renderer/slash-commands.ts'
import { startLike } from '../src/renderer/clear-thread.ts'
import { createRegistry } from '../src/renderer/registry.tsx'
import { defineUiExtension } from '../src/renderer/extension-api.ts'

const thread = (more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: '1', title: 't', cwd: '/repo/app', createdAt: 0, activeAt: 0, project: { root: '/repo', name: 'repo' }, status: { state: 'idle' }, ...more,
})

describe('commands', () => {
  it('reads a message that is a command, by any of its names and any case, with what follows it', () => {
    const here = thread()
    expect(commandIn('/clear', here)).toEqual({ command: 'clear', rest: '' })
    expect(commandIn('  /NEW  ', here)).toEqual({ command: 'clear', rest: '' })
    expect(commandIn('/clear fix the tests\nand then lint ', here)).toEqual({ command: 'clear', rest: 'fix the tests\nand then lint' })
    expect(commandIn('/compact keep the API changes', here)).toEqual({ command: 'compact', rest: 'keep the API changes' })
    for (const text of ['/clearer', '/clea', 'clear', 'please /clear', '/skill:clear', '/usr/bin/clear', '/']) expect(commandIn(text, here)).toBeUndefined()
  })
  it("is only a command where the thread takes it: Ego's compacts and doesn't clear, an archived one does neither", () => {
    const ego = thread({ hidden: true, owner: 'ego' })
    expect(commandIn('/clear', ego)).toBeUndefined()
    expect(commandIn('/compact', ego)).toEqual({ command: 'compact', rest: '' })
    expect(commandIn('/compact', thread({ archived: true }))).toBeUndefined()
    expect(commandIn('/clear', undefined)).toBeUndefined()
    expect([takes('clear', thread()), takes('clear', ego), takes('compact', ego)]).toEqual([true, false, true])
  })
  it('offers those a name starts, the alias only where it is what is typed, each run as it is taken', () => {
    expect(commandsFor('')).toEqual([
      expect.objectContaining({ label: '/clear', insert: '/clear ', submit: true }),
      expect.objectContaining({ label: '/compact', insert: '/compact ', submit: true }),
    ])
    expect(commandsFor('CL').map((c) => c.label)).toEqual(['/clear'])
    expect(commandsFor('co').map((c) => c.label)).toEqual(['/compact'])
    expect(commandsFor('n').map((c) => c.label)).toEqual(['/new'])
    expect(commandsFor('x')).toEqual([])
  })
  it('completes a `/` opening the message, up to the caret', () => {
    expect(commandAt('/cl', 3)).toEqual({ start: 0, query: 'cl' })
    expect(commandAt('/', 1)).toEqual({ start: 0, query: '' })
    expect(commandAt('/clear now', 10)).toBeUndefined()
    expect(commandAt('/clear', 3)).toBeUndefined()
    expect(commandAt('see /cl', 7)).toBeUndefined()
  })
  it("offers a thread's own: none in the New thread dialog", async () => {
    const machine = { id: 'local', label: 'local', state: 'connected' as const }
    const offered = async (t?: ThreadInfo) => (await commandCompletions.items({ start: 0, query: '' }, { machine, cwd: '/', ...t ? { thread: t } : {} }, { signal: new AbortController().signal, update: () => {} })).map((c) => c.label)
    expect(await offered(thread())).toEqual(['/clear', '/compact'])
    expect(await offered(thread({ hidden: true, owner: 'ego' }))).toEqual(['/compact'])
    expect(await offered(thread({ archived: true }))).toEqual([])
    expect(await offered()).toEqual([])
  })
})

describe('a thread started in place of another', () => {
  const app = defineApp({ name: 'superego', id: 'superego' })
  const trees = defineUiExtension({ name: 'worktrees', setup(superego) { superego.newThreadField({ component: () => null, from: (t) => t.facts?.worktrees ? true : undefined }) } })
  const registry = createRegistry(app, [trees], () => {})
  const machine = { id: 'box', label: 'box', state: 'connected' as const, extensions: [{ name: 'worktrees' }] } as never
  it('takes its folder within its project, its profile, model and thinking', () => {
    const profile = { name: 'reviewer', scope: 'user' as const, dir: '/p' }
    expect(startLike(registry, machine, thread({ profile, chosen: { model: 'a/b', thinking: 'high' } })))
      .toEqual({ machine: 'box', cwd: '/repo/app', profile: 'reviewer', model: 'a/b', thinking: 'high' })
    // A folder beside its project's, with the same start, isn't in it.
    expect(startLike(registry, machine, thread({ cwd: '/repo-old', project: { root: '/repo', name: 'repo' } })).cwd).toBe('/repo')
  })
  it("starts a worktree's thread from its checkout, with a worktree of its own, where the machine has worktrees", () => {
    const inTree = thread({ cwd: '/data/worktrees/repo/fix-1a2b3c', facts: { worktrees: { path: '/data/worktrees/repo/fix-1a2b3c', branch: 'b', root: '/repo' } } })
    expect(startLike(registry, machine, inTree)).toEqual({ machine: 'box', cwd: '/repo', options: { worktrees: true } })
    const without = { id: 'box', label: 'box', state: 'connected' as const, extensions: [] } as never
    expect(startLike(registry, without, inTree)).toEqual({ machine: 'box', cwd: '/repo' })
  })
})

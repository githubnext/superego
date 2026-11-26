// Asking extensions' mention sources as `@` is typed, kept lean: a list once per word, a search debounced and aborted
// as the word changes, a slow or failing source given up on without holding up the rest, and what the menu shows
// arriving as it comes, the fast first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Completion, CompletionAsk, CompletionProvider, ComposerWhere, MachineEntry, MentionItem, MentionSource, ThreadInfo, UiApi } from '@superego/app/ui'
import { createLookup, MAX_CANDIDATES } from '../src/sources.ts'
import mentionsUi, { SOFT_WINDOW } from '../src/ui.tsx'

const local: MachineEntry = { id: 'local', label: 'This Mac', state: 'connected' }
const where: ComposerWhere = { machine: local, cwd: '' }
const item = (id: string, label = id): MentionItem => ({ id, label })
const labels = (asked: { now?: { items: readonly MentionItem[] } }) => asked.now?.items.map((i) => i.label)

/** A source whose list or search the test answers, recording each call and the signal it was given. */
function controlled(kind: string, how: 'list' | 'search') {
  const calls: { query?: string; signal: AbortSignal; answer(items: MentionItem[]): void; fail(error: Error): void }[] = []
  const ask = (query: string | undefined, signal: AbortSignal) => new Promise<MentionItem[]>((answer, fail) => { calls.push({ ...query !== undefined ? { query } : {}, signal, answer, fail }) })
  const source: MentionSource = how === 'list'
    ? { kind, title: kind, list: (_where, { signal }) => ask(undefined, signal) }
    : { kind, title: kind, search: (query, _where, { signal }) => ask(query, signal) }
  return { source, calls }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('asking sources for the word typed', () => {
  it('asks a list once while the word grows, matching it again with no call, and again for another word', async () => {
    const lookup = createLookup()
    let listed = 0
    const notes: MentionSource = { kind: 'note', title: 'Notes', list: () => { listed++; return [item('roadmap'), item('q4')] } }
    for (const query of ['', 'r', 'ro', 'roa']) {
      const asking = new AbortController()
      expect(labels(lookup.ask([notes], query, where, 4, asking.signal)[0]!)).toEqual(['roadmap', 'q4'])
      asking.abort()
    }
    expect(listed).toBe(1)
    // Another word (it starts elsewhere), or another folder: asked again.
    lookup.ask([notes], '', where, 9, new AbortController().signal)
    lookup.ask([notes], '', { ...where, cwd: '/elsewhere' }, 9, new AbortController().signal)
    expect(listed).toBe(3)
  })

  it('waits for a list being asked rather than asking again, and aborts it once the word is left', async () => {
    const lookup = createLookup()
    const { source, calls } = controlled('canvas', 'list')
    const first = new AbortController()
    const asked = lookup.ask([source], 'f', where, 0, first.signal)[0]!
    // The next keystroke: the first ask aborted, another following at once.
    first.abort()
    const second = lookup.ask([source], 'fo', where, 0, new AbortController().signal)[0]!
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal.aborted).toBe(false)
    calls[0]!.answer([item('fox')])
    expect((await second.later)?.items).toEqual([item('fox')])
    expect((await asked.later)?.items).toEqual([item('fox')])

    // Left before it answers (no ask follows): aborted.
    const left = new AbortController()
    lookup.ask([source], '', where, 20, left.signal)
    left.abort()
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.signal.aborted).toBe(true)
  })

  it('searches at once for a bare @, then once typing pauses, aborting the search of a word typed on', async () => {
    const lookup = createLookup()
    const { source, calls } = controlled('doc', 'search')
    lookup.ask([source], '', where, 0, new AbortController().signal)
    expect(calls.map((c) => c.query)).toEqual([''])
    // Typed quickly: each ask aborted by the next before 80ms passed, so only the last is searched.
    for (const query of ['p', 'pl', 'pla']) {
      const asking = new AbortController()
      lookup.ask([source], query, where, 0, asking.signal)
      await vi.advanceTimersByTimeAsync(30)
      asking.abort()
    }
    const last = new AbortController()
    const asked = lookup.ask([source], 'plan', where, 0, last.signal)[0]!
    await vi.advanceTimersByTimeAsync(79)
    expect(calls.map((c) => c.query)).toEqual([''])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.map((c) => c.query)).toEqual(['', 'plan'])
    // Typed on while it searches: aborted, and its answer offers nothing.
    last.abort()
    expect(calls[1]!.signal.aborted).toBe(true)
    calls[1]!.answer([item('plan')])
    expect(await asked.later).toBeUndefined()
  })

  it('gives a source 800ms, then aborts it, says so and offers nothing of it for the word', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lookup = createLookup()
    const { source, calls } = controlled('canvas', 'list')
    const asked = lookup.ask([source], '', where, 0, new AbortController().signal)[0]!
    await vi.advanceTimersByTimeAsync(800)
    expect(calls[0]!.signal.aborted).toBe(true)
    expect(await asked.later).toEqual({ kind: 'canvas', items: [], searched: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mention source canvas: its list took over 800ms'))
    // Not asked again while the word is typed.
    expect(labels(lookup.ask([source], 'f', where, 0, new AbortController().signal)[0]!)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('offers nothing of a source that throws or answers no list, and cuts one that answers too much', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lookup = createLookup()
    const throws: MentionSource = { kind: 'a', title: 'A', list: () => { throw new Error('no') } }
    const rejects: MentionSource = { kind: 'b', title: 'B', search: async () => { throw new Error('no') } }
    const wrong: MentionSource = { kind: 'c', title: 'C', list: () => ({ nope: true }) as never }
    const huge: MentionSource = { kind: 'd', title: 'D', list: () => [...Array.from({ length: 2000 }, (_, i) => item(`n${i}`)), item('')] }
    const bad: MentionSource = { kind: 'e', title: 'E', list: () => [item('ok'), item('say "hi"'), { id: 'x' } as MentionItem] }
    const [a, b, c, d, e] = lookup.ask([throws, rejects, wrong, huge, bad], '', where, 0, new AbortController().signal)
    expect(labels(a!)).toEqual([])
    expect((await b!.later)?.items).toEqual([])
    expect(labels(c!)).toEqual([])
    expect(d!.now!.items).toHaveLength(MAX_CANDIDATES)
    expect(labels(e!)).toEqual(['ok'])
    expect(error).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mention source d answered 2001 items; only the first 500'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Mention source e: 2 items left out'))
  })
})

describe('the menu, as sources answer', () => {
  /** The Mentions extension's provider, set up with these sources and threads. */
  function provider(sources: MentionSource[], threads: ThreadInfo[] = []) {
    let found: CompletionProvider | undefined
    const api = {
      composer: { complete: (p: CompletionProvider) => { found = p }, sentWith: () => {}, mentionSources: () => sources, mention: () => {} },
      window: { machines: [local], threads: { local: threads } },
    } as unknown as UiApi
    mentionsUi.setup(api)
    return found!
  }
  const thread = (id: string, title: string): ThreadInfo => ({ id, title, cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' } })
  const ask = () => {
    const updates: string[][] = []
    const controller = new AbortController()
    const asking: CompletionAsk = { signal: controller.signal, update: (items) => updates.push(items.map((i) => i.label)) }
    return { asking, updates, controller }
  }
  const shown = (items: Completion[]) => items.map((i) => i.label)

  it('shows the fast at once and the slow as it comes, and gives up on one too slow without holding the rest', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fast: MentionSource = { kind: 'note', title: 'Notes', list: () => [item('roadmap', 'Roadmap')] }
    const slow = controlled('canvas', 'list')
    const hung = controlled('board', 'list')
    const items = provider([fast, slow.source, hung.source], [thread('1', 'Ready')])
    const { asking, updates } = ask()
    let answer: Completion[] | undefined
    void Promise.resolve(items.items({ start: 0, query: '' }, where, asking)).then((a) => { answer = a })
    await vi.advanceTimersByTimeAsync(SOFT_WINDOW)
    // Within the moment it waits: the thread and the fast source.
    expect(answer && shown(answer)).toEqual(['Ready', 'Roadmap'])
    slow.calls[0]!.answer([item('fox', 'Fox')])
    await vi.advanceTimersByTimeAsync(1)
    expect(updates.at(-1)).toEqual(['Ready', 'Roadmap', 'Fox'])
    await vi.advanceTimersByTimeAsync(800)
    expect(hung.calls[0]!.signal.aborted).toBe(true)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Mention source board'))
    expect(updates.at(-1)).toEqual(['Ready', 'Roadmap', 'Fox'])
  })

  it('answers at once when every source has, and asks a scoped kind alone (no other source, no files)', async () => {
    let asked: string[] = []
    const source = (kind: string, n: number): MentionSource => ({ kind, title: kind, list: () => { asked.push(kind); return Array.from({ length: n }, (_, i) => item(`${kind}${i}`)) } })
    const items = provider([source('canvas', 15), source('note', 15)], [thread('1', 'canvas thread')])
    const scoped = items.items({ start: 0, query: 'canvas:' }, where, ask().asking)
    expect(Array.isArray(scoped)).toBe(true)
    expect((scoped as Completion[]).map((i) => i.insert)).toEqual(Array.from({ length: 10 }, (_, i) => `@canvas:canvas${i} `))
    expect(asked).toEqual(['canvas'])
    asked = []
    // @thread: asks no source.
    const threads = await items.items({ start: 3, query: 'thread:' }, where, ask().asking)
    expect(shown(threads)).toEqual(['canvas thread'])
    expect(asked).toEqual([])
  })
})

// Mentions as text: the `@word` the composer completes, what it offers and in which order, what taking one writes, how a
// message's mentions are found, and how a sent message's are drawn as links.
import { describe, expect, it } from 'vitest'
import type { MachineEntry, MentionItem, ThreadInfo } from '@superego/app/ui'
import { mentionHref, mentionRef } from '@superego/protocol'
import { MAX_MENTIONS, mentionAt, offers, scopeOf, type Offer } from '../src/complete.ts'
import { fileRef, mentionLinks, mentionsBlock, mentionsIn, otherLine, sentMentions } from '../src/shared.ts'

/** An offer as a line: what it is, and what taking it writes. */
const describe_ = (o: Offer) => o.kind === 'thread' ? `thread ${o.thread.title} → ${o.insert}` : o.kind === 'file' ? `file ${o.path} → ${o.insert}` : `${o.type} ${o.item.label} → ${o.insert}`

const thread = (id: string, title: string, activeAt: number, state: ThreadInfo['status']['state'] = 'idle'): ThreadInfo =>
  ({ id, title, cwd: '/work', createdAt: 0, activeAt, project: { root: '/work', name: 'work' }, status: { state } })
const local: MachineEntry = { id: 'local', label: 'This Mac', state: 'connected' }
const box: MachineEntry = { id: 'm-9', label: 'workbox', state: 'connected' }
const away: MachineEntry = { id: 'm-1', label: 'laptop', state: 'disconnected' }

describe('the word being mentioned', () => {
  it('is an @ at the start of a word, up to the caret', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('see @src/ap', 11)).toEqual({ start: 4, query: 'src/ap' })
    expect(mentionAt('see (@da', 8)).toEqual({ start: 5, query: 'da' })
    expect(mentionAt('ask @thread:fo', 14)).toEqual({ start: 4, query: 'thread:fo' })
  })
  it("isn't an address, a word already typed on past the caret, or one a space ended", () => {
    expect(mentionAt('me@host', 7)).toBeUndefined()
    expect(mentionAt('@datesx', 3)).toBeUndefined()
    expect(mentionAt('@dates now', 10)).toBeUndefined()
  })
})

describe('what a mention offers', () => {
  const threads = {
    local: [thread('1', 'Dates land a day early', 30), thread('2', 'Focus ring', 20), thread('3', 'Update dates parser', 10), thread('here', 'This one', 40)],
    'm-9': [thread('7', 'Deploy dashboards', 25)],
    'm-1': [thread('8', 'Dates offline', 50)],
  }
  const files = ['README.md', 'src/dates.ts', 'src/deep/dates/index.ts', 'test/dates.test.ts', 'docs/notes.md']
  const offer = (query: string) => offers({ query, machine: 'local', here: 'here', machines: [local, box, away], threads, files })
    .map(describe_)

  it('offers threads first, by how well they match and then the most recent, then files', () => {
    expect(offer('dates')).toEqual([
      'thread Dates land a day early → @thread:1 ',
      'thread Update dates parser → @thread:3 ',
      'file src/dates.ts → @src/dates.ts ',
      'file test/dates.test.ts → @test/dates.test.ts ',
      'file src/deep/dates/index.ts → @src/deep/dates/index.ts ',
    ])
  })
  it('names the machine of a thread elsewhere, leaves out this thread and machines not connected', () => {
    expect(offer('')).toEqual([
      'thread Dates land a day early → @thread:1 ',
      'thread Deploy dashboards → @thread:workbox/7 ',
      'thread Focus ring → @thread:2 ',
      'thread Update dates parser → @thread:3 ',
      'file README.md → @README.md ',
      'file src/dates.ts → @src/dates.ts ',
      'file docs/notes.md → @docs/notes.md ',
      'file test/dates.test.ts → @test/dates.test.ts ',
      'file src/deep/dates/index.ts → @src/deep/dates/index.ts ',
    ])
  })
  it('offers threads alone for thread:', () => {
    expect(offer('thread:de')).toEqual(['thread Deploy dashboards → @thread:workbox/7 ', 'thread Dates land a day early → @thread:1 '])
  })
  it('names a machine by its id where its name is more than a word, and quotes a path that would end early', () => {
    const named = offers({ query: 'deploy', machine: 'local', here: 'here', machines: [{ ...box, label: 'Work box' }], threads, files: [] })
    expect(named.map((o) => o.insert)).toEqual(['@thread:m-9/7 '])
    expect(fileRef('notes/my plan.md')).toBe('@"notes/my plan.md"')
    expect(fileRef('src/a.ts')).toBe('@src/a.ts')
  })
})

describe('mentions in a message', () => {
  it('finds threads, here and elsewhere, and paths, each once, none in code', () => {
    expect(mentionsIn('see @thread:12 and @thread:workbox/7, then @src/a.ts. Also @"my plan.md" and `@src/b.ts`, me@host, @src/a.ts')).toEqual([
      { ref: '@thread:12', kind: 'thread', id: '12' },
      { ref: '@thread:workbox/7', kind: 'thread', id: '7', machine: 'workbox' },
      { ref: '@src/a.ts', kind: 'file', path: 'src/a.ts' },
      { ref: '@"my plan.md"', kind: 'file', path: 'my plan.md' },
    ])
  })
  it('reads a sent message\'s block back, and draws the mentions it names as links', () => {
    const block = mentionsBlock([
      '@thread:12 is a thread: "Dates" (Idle). Read it with thread_read (thread: "12").',
      '@thread:workbox/7 is a thread on workbox: "Deploy" (Working). Read it with thread_read (thread: "7", machine: "workbox").',
      '@src/a_b.ts is a file, relative to this thread\'s folder.',
      '@"my plan.md" is a file, relative to this thread\'s folder.',
    ])
    const read = sentMentions([{ type: 'text', text: 'hi' }, { type: 'text', text: block }])!
    expect(read.blocks).toEqual([1])
    expect(read.items.map((i) => `${i.kind} ${i.ref}`)).toEqual(['thread @thread:12', 'thread @thread:workbox/7', 'file @src/a_b.ts', 'file @"my plan.md"'])
    expect(sentMentions([{ type: 'text', text: 'hi' }])).toBeUndefined()
    // @someone named no file: left as typed.
    expect(mentionLinks('ask @thread:12 and @thread:workbox/7 about @src/a_b.ts, @"my plan.md" and @someone; `@src/a_b.ts`', read.items)).toBe(
      'ask [@thread:12](thread:12) and [@thread:workbox/7](thread:workbox/7) about [@src/a\\_b.ts](<src/a_b.ts>), [@"my plan.md"](<my plan.md>) and @someone; `@src/a_b.ts`',
    )
  })
})

describe("an extension's things, as written", () => {
  it('writes an id bare, or quoted where it has a space or a character that would end it', () => {
    expect(mentionRef('canvas', 'fox-and-rhino')).toBe('@canvas:fox-and-rhino')
    expect(mentionRef('note', '2026/plan')).toBe('@note:2026/plan')
    expect(mentionRef('canvas', 'Fox & Rhino')).toBe('@canvas:"Fox & Rhino"')
    expect(mentionRef('note', 'plan, v2')).toBe('@note:"plan, v2"')
    expect(mentionRef('note', 'plan.')).toBe('@note:"plan."')
    expect(() => mentionRef('note', 'say "hi"')).toThrow(/can't name/)
    expect(() => mentionRef('note', '')).toThrow(/can't name/)
    expect(mentionHref('canvas', 'Fox & Rhino')).toBe('canvas:Fox%20%26%20Rhino')
  })
  it('finds them in a message, bare and quoted, not in code, not in an address, without the sentence\'s full stop', () => {
    expect(mentionsIn('see @canvas:fox-and-rhino, @canvas:"Fox & Rhino" and @note:2026/plan. Then @canvas:shoes. Not `@canvas:x`,\n```\n@note:y\n```\nnor me@canvas:z')).toEqual([
      { ref: '@canvas:fox-and-rhino', kind: 'other', type: 'canvas', id: 'fox-and-rhino', quoted: false },
      { ref: '@canvas:"Fox & Rhino"', kind: 'other', type: 'canvas', id: 'Fox & Rhino', quoted: true },
      { ref: '@note:2026/plan', kind: 'other', type: 'note', id: '2026/plan', quoted: false },
      { ref: '@canvas:shoes', kind: 'other', type: 'canvas', id: 'shoes', quoted: false },
    ])
    // The Mentions extension's own kinds aren't an extension's.
    expect(mentionsIn('@file:"a b" @folder:x')).toEqual([{ ref: '@folder:x', kind: 'file', path: 'folder:x' }])
  })
  it('reads them back from the block, and links them as their source says', () => {
    const block = mentionsBlock([
      '@thread:12 is a thread: "Dates" (Idle). Read it with thread_read (thread: "12").',
      '@src is a folder, relative to this thread\'s folder.',
      '@a.md is a file, relative to this thread\'s folder.',
      otherLine('@canvas:fox-and-rhino', 'canvas', '"Fox & Rhino". Read it with canvas_read (id: "fox-and-rhino").'),
      otherLine('@canvas:"Fox & Rhino"', 'canvas', 'the same,\n  quoted.'),
      otherLine('@note:2026/plan', 'note', 'a plan.'),
      otherLine('@ink:x', 'ink', 'an ink.'),
    ])
    expect(block).toContain('@canvas:"Fox & Rhino" is a canvas: the same, quoted.')
    expect(block).toContain('@ink:x is an ink: an ink.')
    const { items } = sentMentions([{ type: 'text', text: 'hi' }, { type: 'text', text: block }])!
    expect(items.map((i) => `${i.kind} ${i.ref}`)).toEqual([
      'thread @thread:12', 'folder @src', 'file @a.md', 'canvas @canvas:fox-and-rhino', 'canvas @canvas:"Fox & Rhino"', 'note @note:2026/plan', 'ink @ink:x',
    ])
    const text = 'See @thread:12, @src, @a.md, @canvas:fox-and-rhino, @canvas:"Fox & Rhino", @note:2026/plan, @ink:x and @canvas:missing. `@canvas:fox-and-rhino`'
    // By default `<kind>:<id>`, the id URI-encoded.
    expect(mentionLinks(text, items)).toBe(
      'See [@thread:12](thread:12), [@src](<src>), [@a.md](<a.md>), [@canvas:fox-and-rhino](<canvas:fox-and-rhino>), [@canvas:"Fox & Rhino"](<canvas:Fox%20%26%20Rhino>), '
      + '[@note:2026/plan](<note:2026%2Fplan>), [@ink:x](<ink:x>) and @canvas:missing. `@canvas:fox-and-rhino`',
    )
    // A source's own href; one with none (`href: false`) leaves its mentions as written.
    const href = (kind: string, id: string) => kind === 'note' ? undefined : kind === 'canvas' ? `https://canvas.example/${encodeURIComponent(id)}` : mentionHref(kind, id)
    expect(mentionLinks('@canvas:"Fox & Rhino" and @note:2026/plan', items, href)).toBe('[@canvas:"Fox & Rhino"](<https://canvas.example/Fox%20%26%20Rhino>) and @note:2026/plan')
  })
  it('links a bare one the block says is a file as the file it is', () => {
    const { items } = sentMentions([{ type: 'text', text: mentionsBlock(['@notes:old.md is a file, relative to this thread\'s folder.']) }])!
    expect(mentionLinks('see @notes:old.md', items)).toBe('see [@notes:old.md](<notes:old.md>)')
  })
})

describe("what @ offers of extensions' things", () => {
  const item = (id: string, label = id, extra: Partial<MentionItem> = {}): MentionItem => ({ id, label, ...extra })
  const many = (kind: string, n: number) => ({ kind, items: Array.from({ length: n }, (_, i) => item(`${kind}-${i}`, `${kind} ${i}`)) })
  const threads = { local: Array.from({ length: 8 }, (_, i) => thread(`${i}`, `Thread ${i}`, i)) }
  const files = Array.from({ length: 8 }, (_, i) => `f${i}.md`)
  const offer = (query: string, sources: { kind: string; items: MentionItem[]; searched?: boolean }[], kinds = sources.map((s) => s.kind)) =>
    offers({ query, machine: 'local', machines: [local], threads, files, sources, kinds })

  it('offers at most 5 threads and 3 of each source beside each other, 10 in all, files filling what\'s left', () => {
    const all = offer('', [many('canvas', 20), many('note', 20)])
    expect(all).toHaveLength(MAX_MENTIONS)
    expect(all.map((o) => o.kind === 'other' ? o.type : o.kind)).toEqual(['thread', 'thread', 'thread', 'thread', 'thread', 'canvas', 'canvas', 'canvas', 'note', 'note'])
    const one = offer('', [many('canvas', 20)])
    expect(one.map((o) => o.kind === 'other' ? o.type : o.kind)).toEqual([...Array(5).fill('thread'), ...Array(3).fill('canvas'), 'file', 'file'])
  })
  it('interleaves what matches by how well, the higher order first among equals, still 3 of each', () => {
    const canvases = { kind: 'canvas', items: [item('fox-and-rhino', 'Fox & Rhino'), item('old-fox', 'Old fox', { order: 1 }), item('the-fox', 'The fox', { order: 5 }), item('foxglove', 'Foxglove'), item('box', 'Box', { keywords: 'fox' })] }
    const notes = { kind: 'note', items: [item('fox', 'Fox notes'), item('q4', 'Q4 plan')] }
    expect(offer('fox', [canvases, notes]).map(describe_)).toEqual([
      'canvas Fox & Rhino → @canvas:fox-and-rhino ',
      'canvas Foxglove → @canvas:foxglove ',
      'note Fox notes → @note:fox ',
      'canvas The fox → @canvas:the-fox ',
    ])
    // Its keywords find it, below what its words match.
    expect(offer('fox', [{ kind: 'canvas', items: [item('box', 'Box', { keywords: 'fox' })] }]).map(describe_)).toEqual(['canvas Box → @canvas:box '])
  })
  it('offers all of a kind whose name is being typed, below what matches by its words', () => {
    const canvases = { kind: 'canvas', items: [item('fox', 'Fox'), item('cancel', 'Cancel plan')] }
    expect(offer('can', [canvases]).map(describe_)).toEqual(['canvas Cancel plan → @canvas:cancel ', 'canvas Fox → @canvas:fox '])
  })
  it('ranks what a search answered among the rest, a match whatever its words', () => {
    const searched = { kind: 'doc', items: [item('d1', 'Unrelated title'), item('d2', 'Plans')], searched: true }
    expect(offer('plan', [searched]).map(describe_)).toEqual(['doc Plans → @doc:d2 ', 'doc Unrelated title → @doc:d1 '])
  })
  it('asks a source alone for its kind, up to 10 of it, and threads or files alone for theirs', () => {
    expect(scopeOf('canvas:fo', ['canvas'])).toEqual({ scope: 'canvas', q: 'fo' })
    expect(scopeOf('canvas:fo', [])).toEqual({ q: 'canvas:fo' })
    expect(scopeOf('file:src', [])).toEqual({ scope: 'file', q: 'src' })
    const scoped = offer('canvas:', [many('canvas', 20), many('note', 20)])
    expect(scoped).toHaveLength(10)
    expect(scoped.every((o) => o.kind === 'other' && o.type === 'canvas')).toBe(true)
    expect(offer('canvas:13', [many('canvas', 20)]).map(describe_)).toEqual(['canvas canvas 13 → @canvas:canvas-13 '])
    expect(offer('file:f1', [many('canvas', 20)]).map(describe_)).toEqual(['file f1.md → @f1.md '])
    expect(offer('thread:', [many('canvas', 20)]).every((o) => o.kind === 'thread')).toBe(true)
  })
  it('writes a taken one, quoted where it must be', () => {
    expect(offer('canvas:fox', [{ kind: 'canvas', items: [item('Fox & Rhino')] }]).map((o) => o.insert)).toEqual(['@canvas:"Fox & Rhino" '])
  })
})

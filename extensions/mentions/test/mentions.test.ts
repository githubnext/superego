// Mentions as text: the `@word` the composer completes, what it offers and in which order, what taking one writes, how a
// message's mentions are found, and how a sent message's are drawn as links.
import { describe, expect, it } from 'vitest'
import type { MachineEntry, ThreadInfo } from '@superego/app/ui'
import { mentionAt, offers } from '../src/complete.ts'
import { fileRef, mentionLinks, mentionsBlock, mentionsIn, sentMentions } from '../src/shared.ts'

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
    .map((o) => o.kind === 'thread' ? `thread ${o.thread.title} → ${o.insert}` : `file ${o.path} → ${o.insert}`)

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

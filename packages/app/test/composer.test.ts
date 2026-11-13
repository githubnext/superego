// What extensions add to the composer: the word a provider completes, what taking an item does to the text, what's
// read out of a sent message, and whose providers and readers a thread sees.
import { describe, expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { complete, completing, readSent, type CompletionProvider, type SentWith } from '../src/renderer/composer.ts'
import { completionsIn, createRegistry, defineUiExtension, sentWithIn } from '../src/renderer/extension.tsx'

const hash: CompletionProvider = {
  title: 'Tags',
  word(text, caret) {
    const match = /(?:^|\s)#(\w*)$/.exec(text.slice(0, caret))
    return match ? { start: caret - match[1]!.length - 1, query: match[1]! } : undefined
  },
  items: (word) => [{ label: `#${word.query}x`, insert: `#${word.query}x ` }],
}
const at: CompletionProvider = { title: 'People', word: (text, caret) => text[caret - 1] === '@' ? { start: caret - 1, query: '' } : undefined, items: () => [] }

describe('composer completions', () => {
  it('completes the word at the caret by the first provider that finds one', () => {
    expect(completing([hash, at], 'see #wo', 7)).toEqual({ provider: hash, word: { start: 4, query: 'wo' } })
    expect(completing([hash, at], 'ask @', 5)?.provider).toBe(at)
    expect(completing([hash, at], 'plain', 5)).toBeUndefined()
  })
  it('puts an item in place of the word, the caret after it, without doubling the space after', () => {
    expect(complete('see #wo now', 7, 4, '#work ')).toEqual({ text: 'see #work now', caret: 10 })
    expect(complete('see #wo', 7, 4, '#work ')).toEqual({ text: 'see #work ', caret: 10 })
    expect(complete('see #wo.', 7, 4, '#work')).toEqual({ text: 'see #work.', caret: 9 })
  })
})

describe('what went with a sent message', () => {
  const marks: SentWith<string> = {
    read: (blocks) => ({ items: blocks.flatMap((b) => b.text?.startsWith('<mark ') ? [b.text.slice(6, -1)] : []), blocks: blocks.flatMap((b, i) => b.text?.startsWith('<mark ') ? [i] : []) }),
    component: () => null,
  }
  const nothing: SentWith = { read: () => undefined, component: () => null }
  it("finds each reader's items and leaves the blocks none claimed for the message's text", () => {
    const blocks = [{ type: 'text', text: 'hello' }, { type: 'text', text: '<mark a>' }, { type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: '<mark b>' }]
    const { found, rest } = readSent([nothing, marks], blocks)
    expect(found).toEqual([{ reader: marks, items: ['a', 'b'] }])
    expect(rest).toEqual([blocks[0], blocks[2]])
  })
})

describe('composer registrations', () => {
  const app = defineApp({ name: 'superego', id: 'superego' })
  const thread = (without?: string[]): ThreadInfo => ({
    id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' }, ...(without ? { without } : {}),
  })
  const sent: SentWith = { read: () => undefined, component: () => null }
  const tags = defineUiExtension({ name: 'tags', setup(superego) { superego.composer.complete(hash); superego.composer.sentWith(sent) } })
  it("offers an extension's completions only where the thread has it, and draws what it sent with messages everywhere", () => {
    const registry = createRegistry(app, [tags], () => {})
    expect(completionsIn(registry, { machine: 'local', thread: thread() }).map((p) => p.title)).toEqual(['Tags'])
    expect(completionsIn(registry, { machine: 'local', thread: thread(['tags']) })).toEqual([])
    // A message it sent with went then; it's still drawn after the thread (or machine) does without it.
    expect(sentWithIn(registry, { machine: 'local', thread: thread(['tags']) })).toHaveLength(1)
  })
  it("keeps a profile's to that profile's threads, and takes them away when it's installed again", () => {
    const registry = createRegistry(app, [], () => {})
    const profile = { scope: 'user' as const, name: 'default', dir: '/p' }
    registry.installProfile('box', profile, [tags])
    const there = { machine: 'box', thread: { ...thread(), profile } }
    expect(completionsIn(registry, there)).toHaveLength(1)
    expect(sentWithIn(registry, there)).toHaveLength(1)
    expect(completionsIn(registry, { machine: 'box', thread: thread() })).toEqual([])
    expect(sentWithIn(registry, { machine: 'local', thread: { ...thread(), profile } })).toEqual([])
    registry.installProfile('box', profile, [])
    expect(completionsIn(registry, there)).toEqual([])
  })
})

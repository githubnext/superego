// Fenced code blocks an extension draws (`superego.codeBlock`): Markdown hands a claimed language's block to it, with
// its source and how the Markdown is set; a language nobody claims, or one a thread goes without, is code as ever. A
// profile's drawer goes before the app's, in its own threads; teardown takes them away.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { defineUiExtension, type CodeBlockProps } from '../src/renderer/extension-api.ts'
import { createRegistry, RegistryProvider, type Registry } from '../src/renderer/registry.tsx'
import { codeBlockOwner, codeBlockView } from '../src/renderer/lookups.ts'
import { LinkPlace } from '../src/renderer/links.tsx'
import { Markdown, type MarkdownProps } from '../src/renderer/Markdown.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'notes', dir: '/home/me/.superego/profiles/notes' }
const thread = (more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' }, ...more,
})

const Drawn = ({ language, code, compact, streaming }: CodeBlockProps) =>
  h('figure', { 'data-language': language, 'data-compact': String(compact), 'data-streaming': String(streaming) }, code)
const Theirs = ({ code }: CodeBlockProps) => h('aside', null, code)
const diagrams = defineUiExtension({ name: 'mermaid', version: '1.0.0', setup(superego) { superego.codeBlock(['Mermaid', 'mmd'], Drawn) } })
const own = defineUiExtension({ name: 'own', setup(superego) { superego.codeBlock('mermaid', Theirs) } })

const fence = (language: string, code: string) => `Before\n\n\`\`\`${language}\n${code}\n\`\`\`\n`
const draw = (registry: Registry, text: string, where: { machine?: string; thread?: ThreadInfo } = {}, props: Partial<MarkdownProps> = {}) =>
  renderToStaticMarkup(h(RegistryProvider, { registry, children: h(LinkPlace.Provider, { value: where }, h(Markdown, { text, ...props })) }))

let registry: Registry | undefined
afterEach(() => { registry?.teardown(); registry = undefined })

describe('code blocks', () => {
  it("draws a claimed language's block with the extension's component, its source without the fence's last newline", () => {
    registry = createRegistry(app, [diagrams], () => {})
    const html = draw(registry, fence('MERMAID', 'flowchart LR\n  a --> b'))
    expect(html).toContain('<figure data-language="mermaid" data-compact="false" data-streaming="false">flowchart LR\n  a --&gt; b</figure>')
    expect(html).not.toContain('<pre')
    // Each of its languages, in a thread too.
    expect(draw(registry, fence('mmd', 'pie'), { machine: 'local', thread: thread() })).toContain('<figure data-language="mmd"')
  })

  it('tells it how the Markdown is set: compact, streaming', () => {
    registry = createRegistry(app, [diagrams], () => {})
    expect(draw(registry, fence('mermaid', 'pie'), {}, { compact: true, streaming: true })).toContain('data-compact="true" data-streaming="true"')
  })

  it("leaves a language nobody claims, and a block with none, as code with its copy button", () => {
    registry = createRegistry(app, [diagrams], () => {})
    for (const text of [fence('ts', 'const a = 1'), '```\nplain\n```']) {
      const html = draw(registry, text)
      expect(html).toContain('<div class="md__code"><pre>')
      expect(html).toContain('md__copy')
      expect(html).not.toContain('<figure')
    }
  })

  it('draws code as code for a thread that goes without the extension, or on a machine that runs another major of it', () => {
    registry = createRegistry(app, [diagrams], () => {})
    const without = { machine: 'local', thread: thread({ without: ['mermaid'] }) }
    expect(draw(registry, fence('mermaid', 'pie'), without)).toContain('<pre><code class="language-mermaid">pie\n</code></pre>')
    expect(codeBlockView(registry, 'mermaid', { machine: 'local', thread: without.thread })).toBeUndefined()
    registry.setMachineExtensions('box', [{ name: 'mermaid', version: '2.0.0' }])
    expect(draw(registry, fence('mermaid', 'pie'), { machine: 'box', thread: thread() })).not.toContain('<figure')
    expect(draw(registry, fence('mermaid', 'pie'), { machine: 'local', thread: thread() })).toContain('<figure')
  })

  it("draws a profile's own ahead of the app's, in that profile's threads only", () => {
    registry = createRegistry(app, [diagrams], () => {})
    registry.installProfile('local', profile, [own])
    const mine = { machine: 'local', thread: thread({ profile }) }
    expect(draw(registry, fence('mermaid', 'pie'), mine)).toContain('<aside>pie</aside>')
    expect(codeBlockOwner(registry, 'mermaid', mine)).toMatchObject({ extension: 'own', profile: expect.any(String) })
    // Its other languages are still the app's; another thread sees the app's.
    expect(draw(registry, fence('mmd', 'pie'), mine)).toContain('<figure')
    expect(draw(registry, fence('mermaid', 'pie'), { machine: 'local', thread: thread() })).toContain('<figure')
    expect(draw(registry, fence('mermaid', 'pie'))).toContain('<figure')
  })

  it("keeps the first of two that claim a language in one scope, and takes them away at teardown", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registry = createRegistry(app, [diagrams, own], () => {})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already drawn by mermaid'))
    expect(registry.codeBlocks.map((c) => c.owner.extension)).toEqual(['mermaid'])
    warn.mockRestore()
    registry.teardown()
    expect(registry.codeBlocks).toEqual([])
    expect(draw(registry, fence('mermaid', 'pie'))).toContain('<pre><code class="language-mermaid">pie\n</code></pre>')
    registry = undefined
  })
})

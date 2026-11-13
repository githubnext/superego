// Link handlers: extensions claim links (a scheme, a pattern, or a test that sees inline code), a profile's ahead of
// the app's, the app's ahead of the core's; Markdown draws a claimed link its handler's way.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { createRegistry, defineUiExtension, linkHandler, RegistryProvider, type LinkProps, type LinkWhere } from '../src/renderer/extension.tsx'
import { follow, LinkPlace, registerLinks, wikilinks } from '../src/renderer/links.tsx'
import { Markdown } from '../src/renderer/Markdown.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const profile = { scope: 'user' as const, name: 'obsidian', dir: '/home/me/.superego/profiles/obsidian' }
const thread = (withProfile = false): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, session: { root: '/', name: '/' }, status: { state: 'idle' },
  ...(withProfile ? { profile } : {}),
})
const inThread = (withProfile = false): LinkWhere => ({ machine: 'local', thread: thread(withProfile), openFile: async () => undefined })
const Note = ({ href, children }: LinkProps) => h('a', { className: 'note', 'data-href': href }, children)
const notes = defineUiExtension({ name: 'notes', setup(superego) { superego.link({ match: 'wikilink:', render: Note, open: () => {} }) } })
const tickets = defineUiExtension({ name: 'tickets', setup(superego) { superego.link({ match: (href, kind) => kind === 'code' && /^[A-Z]+-\d+$/.test(href), open: () => 'closed' }) } })

describe('link handlers', () => {
  it("asks a profile's first, then the app's extensions', then the core's", () => {
    const registry = createRegistry(app, [tickets], registerLinks)
    const where = inThread()
    const core = linkHandler(registry, 'wikilink:plan', 'link', where)
    expect(core?.target?.('wikilink:notes%2Fplan', 'link')).toBe('notes/plan')
    registry.installProfile('local', profile, [notes])
    expect(linkHandler(registry, 'wikilink:plan', 'link', where)).toBe(core)
    expect(linkHandler(registry, 'wikilink:plan', 'link', inThread(true))?.render).toBe(Note)
    // Code an extension reads as its own, ahead of the core's paths.
    expect(linkHandler(registry, 'ABC-12', 'code', where)?.open('ABC-12', { ...where, beside: false, kind: 'code' })).toBe('closed')
    expect(linkHandler(registry, 'src/a.ts', 'code', where)).toBe(linkHandler(registry, 'notes/plan.md', 'link', where))
  })

  it('claims threads, files and web pages only where they can be opened', () => {
    const registry = createRegistry(app, [], registerLinks)
    expect(linkHandler(registry, 'thread:42', 'link', {})).toBeUndefined()
    expect(linkHandler(registry, 'thread:42', 'link', inThread())).toBeDefined()
    expect(linkHandler(registry, 'notes/plan.md', 'link', {})).toBeUndefined()
    expect(linkHandler(registry, '#top', 'link', inThread())).toBeUndefined()
    expect(linkHandler(registry, 'https://a.dev', 'link', {})?.target?.('https://www.a.dev/x/', 'link')).toBe('a.dev/x')
    expect(linkHandler(registry, 'ftp://a.dev', 'link', {})).toBeUndefined()
  })

  it('follows a link, saying why it could not', async () => {
    const registry = createRegistry(app, [], registerLinks)
    const openFile = vi.fn(async (name: string) => name === 'gone.md' ? 'not in /' : undefined)
    const where = { ...inThread(), openFile }
    const files = linkHandler(registry, 'gone.md', 'link', where)!
    expect(await follow(files, 'gone.md', 'link', where, false)).toBe('not in /')
    expect(await follow(files, 'wikilink:a%20b', 'link', where, true)).toBeUndefined()
    expect(openFile).toHaveBeenLastCalledWith('a b')
    expect(await follow({ match: 'x:', open: () => { throw new Error('nope') } }, 'x:1', 'link', where, false)).toBe('nope')
  })

  it('turns [[wikilinks]] into links, leaving code alone', () => {
    expect(wikilinks('see [[notes/plan|the plan]] and `[[not]]`')).toBe('see [the plan](<wikilink:notes%2Fplan>) and `[[not]]`')
  })

  it("draws a claimed link its handler's way in Markdown, and others as web links", () => {
    const registry = createRegistry(app, [], registerLinks)
    registry.installProfile('local', profile, [notes])
    const draw = (where: LinkWhere, text: string) => renderToStaticMarkup(h(RegistryProvider, { registry, children: h(LinkPlace.Provider, { value: where }, h(Markdown, { text })) }))
    const mine = draw(inThread(true), 'see [[plan]] and `src/a.ts` and [docs](https://a.dev)')
    expect(mine).toContain('class="note" data-href="wikilink:plan"')
    expect(mine).toContain('class="md__file md__file--code"')
    expect(mine).toContain('href="https://a.dev" target="_blank"')
    const theirs = draw(inThread(), 'see [[plan]]')
    expect(theirs).toContain('class="md__file"')
    // Nowhere to open files: [[wikilinks]] stay text, a thread: link isn't one.
    const nowhere = draw({}, 'see [[plan]] and [it](thread:4)')
    expect(nowhere).toContain('[[plan]]')
    expect(nowhere).not.toContain('thread:4')
  })
})

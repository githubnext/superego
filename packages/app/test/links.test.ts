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

  it('claims files and web pages only where they can be opened, and threads not at all (the threads extension does)', () => {
    const registry = createRegistry(app, [], registerLinks)
    expect(linkHandler(registry, 'thread:42', 'link', inThread())).toBeUndefined()
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

  it('keeps, in HTML files, links of the schemes handlers claim: by their match, or the scheme a test says', () => {
    const Ticket = ({ href, children }: LinkProps) => h('a', { className: 'ticket', 'data-href': href }, children)
    const claims = defineUiExtension({ name: 'claims', setup(superego) { superego.link({ scheme: 'ticket', match: (href, kind) => kind === 'link' && /^ticket:\d+$/.test(href), render: Ticket, open: () => {} }) } })
    const registry = createRegistry(app, [claims], registerLinks)
    const html = renderToStaticMarkup(h(RegistryProvider, { registry, children: h(LinkPlace.Provider, { value: inThread() }, h(Markdown, { text: '<a href="ticket:12">t</a> <a href="wikilink:a.md">a</a> <a href="other:1">o</a>', html: true })) }))
    expect(html).toContain('class="ticket" data-href="ticket:12"')
    expect(html).toContain('class="md__file"')
    expect(html).not.toContain('other:1')
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
    // Nowhere to open files: [[wikilinks]] stay text.
    expect(draw({}, 'see [[plan]]')).toContain('[[plan]]')
  })

  it("keeps an HTML link's own attributes when a handler draws it", () => {
    const registry = createRegistry(app, [], registerLinks)
    const html = renderToStaticMarkup(h(RegistryProvider, { registry, children: h(LinkPlace.Provider, { value: inThread() },
      h(Markdown, { html: true, text: '<a href="https://a.dev" id="go" aria-label="Go">Go</a> and <a href="plan.md" id="plan">plan</a>' })) }))
    expect(html).toContain('<a id="user-content-go" aria-label="Go" href="https://a.dev"')
    expect(html).toContain('<a id="user-content-plan" href="#" class="md__file"')
  })

  it('matches a /g or /y pattern every time, not every other', () => {
    const tickets = defineUiExtension({ name: 'tickets', setup(superego) { superego.link({ match: /^ticket:\d+/gy, open: () => {} }) } })
    const registry = createRegistry(app, [tickets], registerLinks)
    for (let i = 0; i < 3; i++) expect(linkHandler(registry, 'ticket:12', 'link', inThread())).toBeDefined()
  })
})

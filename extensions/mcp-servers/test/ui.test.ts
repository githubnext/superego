// mcp-servers, UI half: what it says of servers and calls (describe.ts), the Add dialog's form, the catalogue, and what
// it draws: MCP calls' and tool_search's rows, the header chip and thread details' list, and a server's row in
// Settings (its state, Sign in or Set key, Allow with the whole command line).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ToolRowCall } from '@superego/app/ui'
import { createRouter, defineAction, type ThreadInfo } from '@superego/protocol'
import { mountUi, type TestWindow } from '@superego/sdk/testing'
import mcpServers, { Chip, NoticeFor } from '../src/ui.tsx'
import { ServerRow } from '../src/settings.tsx'
import { CATALOG, fromCatalog } from '../src/catalog.ts'
import { ago, authMenu, checkText, commandLine, configOf, emptyForm, formOf, nameFrom, secretLabel, secretPlaceholder, signInDetails, signInText, splitCommandLine, stateText } from '../src/describe.ts'
import { ADD_PARAMS, splitToolName, type ServerInfo, type ThreadServers } from '../src/shared.ts'

const machine = { id: 'local', label: 'This Mac', state: 'connected' } as never
const servers: ThreadServers = {
  servers: [
    { id: 'linear', name: 'linear', title: 'Linear', from: 'machine', state: 'running', tools: 23 },
    { id: 'github', name: 'github', from: 'machine', state: 'needs-sign-in', tools: 40, deferred: true, error: 'Set its key' },
  ],
  left: [{ name: 'sentry', why: 'missing' }],
}
const thread = (ext?: ThreadServers): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' },
  ...(ext ? { facts: { 'mcp-servers': ext } } : {}),
})
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element).replace(/<!-- -->/g, '')
const info = (patch: Partial<ServerInfo> = {}): ServerInfo => ({
  id: 'linear', name: 'linear', from: { type: 'machine' }, runs: 'mcp.linear.app', config: { title: 'Linear', url: 'https://mcp.linear.app/mcp', auth: { type: 'oauth' } },
  state: 'running', tools: 23, secrets: [], ...patch,
})

describe('words', () => {
  it('splits a command line as a shell would, and quotes it back', () => {
    expect(splitCommandLine(`npx -y @sentry/mcp-server --title "a b" 'c d' e\\ f`)).toEqual(['npx', '-y', '@sentry/mcp-server', '--title', 'a b', 'c d', 'e f'])
    expect(splitCommandLine('  ')).toEqual([])
    expect(splitCommandLine(`x ""`)).toEqual(['x', ''])
    expect(commandLine({ command: 'npx', args: ['-y', '@sentry/mcp-server', 'a b'], env: { SENTRY_HOST: 'sentry.io' }, cwd: '/p q' }))
      .toBe(`cd '/p q' && SENTRY_HOST=sentry.io npx -y @sentry/mcp-server 'a b'`)
    expect(commandLine({ url: 'https://x' } as never)).toBe('')
  })

  it('names a server from its URL or the package its command runs', () => {
    expect(nameFrom({ url: 'https://mcp.linear.app/mcp' })).toBe('linear')
    expect(nameFrom({ url: 'https://api.githubcopilot.com/mcp/' })).toBe('githubcopilot')
    expect(nameFrom({ url: 'http://127.0.0.1:3845/mcp' })).toBeUndefined()
    expect(nameFrom({ url: 'not a url' })).toBeUndefined()
    expect(nameFrom({ command: 'npx', args: ['-y', '@sentry/mcp-server'] })).toBe('sentry')
    expect(nameFrom({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe('playwright')
    expect(nameFrom({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] })).toBe('chrome-devtools')
    expect(nameFrom({ command: 'npx', args: ['@modelcontextprotocol/server-filesystem', '/tmp'] })).toBe('filesystem')
    expect(nameFrom({ command: 'node', args: ['./tools/docs-mcp.js'] })).toBe('docs')
    expect(nameFrom({ command: '/usr/local/bin/Acme_Tools' })).toBe('acme-tools')
  })

  it("says a server's state, and how a check went", () => {
    expect(stateText(info())).toBe('Running · 23 tools')
    expect(stateText(info({ deferred: true, tools: 1 }))).toBe('Running · 1 tool, found by search')
    expect(stateText(info({ config: { command: 'x', lifetime: 'thread' }, running: 2 }))).toBe('Running in 2 threads · 23 tools')
    expect(stateText(info({ state: 'stopped', tools: undefined }))).toBe('Stopped')
    expect(stateText(info({ state: 'waiting' }))).toBe('Waiting for Allow')
    expect(checkText(info({ state: 'stopped', listedAt: 1 }))).toEqual({ ok: true, text: 'Connected · 23 tools' })
    expect(checkText(info({ state: 'needs-sign-in' }))).toEqual({ ok: true, text: 'Saved; sign in to connect' })
    expect(checkText(info({ state: 'failed', error: 'exited with code 1' }))).toEqual({ ok: false, text: 'exited with code 1' })
  })

  it("says how an OAuth server's sign-in stands, briefly, and the rest for its tooltip", () => {
    const now = 10 * 86_400_000
    expect(ago(now - 30_000, now)).toBe('just now')
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(ago(now - 3 * 86_400_000, now)).toBe('3 days ago')
    expect(signInText(undefined, now)).toBeUndefined()
    expect(signInText({ signedIn: false }, now)).toBeUndefined()
    expect(signInText({ signedIn: true }, now)).toBe('Signed in')
    expect(signInText({ signedIn: true, since: now - 3 * 86_400_000, expires: now + 40 * 60_000, refreshes: true }, now)).toBe('Signed in 3 days ago')
    // Close to running out, and nothing to renew it with.
    expect(signInText({ signedIn: true, since: now - 3_600_000, expires: now + 40 * 60_000 }, now)).toBe('Signed in, expires in 40 min')
    expect(signInText({ signedIn: true, since: now - 3_600_000, expires: now + 5 * 86_400_000 }, now)).toBe('Signed in 1 h ago')
    expect(signInText({ signedIn: true, since: now - 3_600_000, expires: now - 1 }, now)).toBe('Sign-in expired')
    const date = (ms: number) => `@${ms}`
    expect(signInDetails({ signedIn: true, since: 1, expires: 2, refreshes: true, scope: 'read write' }, date)).toBe('Signed in @1\nRenews on its own\nScope: read write')
    expect(signInDetails({ signedIn: true, since: 1, expires: 2 }, date)).toBe('Signed in @1\nExpires @2')
    expect(signInDetails({ signedIn: true }, date)).toBeUndefined()
    expect(signInDetails({ signedIn: false, since: 1 }, date)).toBeUndefined()
  })

  it("labels a server's secrets, an OAuth client's as optional, and offers what fits in its menu", () => {
    expect(secretLabel('key')).toBe('API key')
    expect(secretLabel('client-secret')).toBe('Client secret')
    expect(secretLabel('SENTRY_ACCESS_TOKEN')).toBeUndefined()
    expect(secretPlaceholder({ name: 'client-secret', set: false, optional: true })).toBe('Optional')
    expect(secretPlaceholder({ name: 'client-secret', set: true, optional: true })).toBe('Set (type to replace)')
    expect(secretPlaceholder({ name: 'key', set: false })).toBe('')
    const oauth = info().config
    const hand = { ...oauth, auth: { type: 'oauth' as const, clientId: 'abc' } }
    expect(authMenu({ config: oauth, secrets: [], oauth: { signedIn: false } })).toEqual({ help: 'Sign in…', clientSecret: false, signOut: false })
    expect(authMenu({ config: oauth, secrets: [], oauth: { signedIn: true } })).toEqual({ clientSecret: false, signOut: true })
    expect(authMenu({ config: hand, secrets: [{ name: 'client-secret', set: true, optional: true }], oauth: { signedIn: false } }))
      .toEqual({ help: 'Sign in…', clientSecret: true, signOut: true })
    expect(authMenu({ config: { url: 'https://x', auth: { type: 'api-key' } }, secrets: [{ name: 'key', set: false }] })).toEqual({ help: 'Set key…', clientSecret: false, signOut: false })
    expect(authMenu({ config: { url: 'https://x', auth: { type: 'api-key' } }, secrets: [{ name: 'key', set: true }] })).toEqual({ help: 'Set key…', clientSecret: false, signOut: true })
    expect(authMenu({ config: { command: 'x' }, secrets: [] })).toEqual({ clientSecret: false, signOut: false })
  })

  it('reads a call by its name', () => {
    expect(splitToolName('mcp__linear__create_issue')).toEqual({ server: 'linear', tool: 'create_issue' })
    expect(splitToolName('mcp__a-b__x__y')).toEqual({ server: 'a-b', tool: 'x__y' })
    expect(splitToolName('read')).toBeUndefined()
    expect(splitToolName('mcp__linear')).toBeUndefined()
  })
})

describe('the Add and Edit form', () => {
  it('makes a command server, its secret env values kept apart', () => {
    const { name, config, secrets } = configOf({
      ...emptyForm(), name: 'sentry', line: 'npx -y @sentry/mcp-server', timeout: '60', lifetime: 'thread',
      env: [{ name: 'SENTRY_HOST', value: 'sentry.io', secret: false }, { name: 'SENTRY_ACCESS_TOKEN', value: 'sntrys_x', secret: true }, { name: '', value: '', secret: false }],
    })
    expect(name).toBe('sentry')
    expect(config).toEqual({
      command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_HOST: 'sentry.io' },
      auth: { type: 'env', names: ['SENTRY_ACCESS_TOKEN'] }, lifetime: 'thread', timeout: 60,
    })
    // The value goes to the store (set-secret), never into the config.
    expect(JSON.stringify(config)).not.toContain('sntrys_x')
    expect(secrets).toEqual({ SENTRY_ACCESS_TOKEN: 'sntrys_x' })
  })

  it('makes a URL server, keeping what it does not show of the one edited', () => {
    const base = { url: 'https://old', headers: { 'X-Team': 'a' }, auth: { type: 'api-key' as const, header: 'X-Key' }, unprofiled: true, allowed: false as const }
    const { config, secrets } = configOf({ ...formOf('gh', base), url: 'https://api.githubcopilot.com/mcp/', key: 'ghp_x' }, base)
    expect(config).toEqual({ url: 'https://api.githubcopilot.com/mcp/', headers: { 'X-Team': 'a' }, auth: { type: 'api-key', header: 'X-Key' }, unprofiled: true })
    expect(secrets).toEqual({ key: 'ghp_x' })
    expect(configOf({ ...formOf('x', { url: 'https://x', auth: { type: 'oauth', scopes: ['read'] } }), auth: 'none' }).config).toEqual({ url: 'https://x' })
  })

  it('says what is wrong', () => {
    expect(() => configOf({ ...emptyForm(), name: 'Bad Name', line: 'x' })).toThrow(/lower-case/)
    expect(() => configOf({ ...emptyForm(), name: 'x' })).toThrow(/command/)
    expect(() => configOf({ ...emptyForm(), kind: 'url', name: 'x', url: 'http://example.com/mcp' })).toThrow(/https/)
    expect(configOf({ ...emptyForm(), kind: 'url', name: 'x', url: 'http://localhost:3000/mcp' }).config.url).toBe('http://localhost:3000/mcp')
    expect(() => configOf({ ...emptyForm(), name: 'x', line: 'x', env: [{ name: 'A-B', value: '', secret: false }] })).toThrow(/variable/)
  })

  it('takes every catalogue entry as the add action does, and round-trips it', async () => {
    const router = createRouter()
    const added: unknown[] = []
    router.register(defineAction({ id: 'mcp-servers.add', title: 'Add', runs: 'machine', expose: ['ui'], params: ADD_PARAMS, run: (params) => { added.push(params); return null } }))
    for (const entry of CATALOG) {
      expect(configOf(formOf(entry.name, entry.server)).config).toEqual(entry.server)
      await router.dispatch('mcp-servers.add', { name: entry.name, server: entry.server }, {}, { source: 'test' })
      // No secrets in it: those are the user's to set, after.
      expect(entry.server.headers).toBeUndefined()
      expect(Object.keys(entry.server.env ?? {}).join()).not.toMatch(/token|key|password|secret/i)
    }
    expect(added).toHaveLength(CATALOG.length)
    expect(fromCatalog('Linear')?.name).toBe('linear')
    expect(fromCatalog('nope')).toBeUndefined()
  })
})

describe('what it draws', () => {
  let ui: TestWindow
  beforeAll(async () => { ui = await mountUi({ extensions: [mcpServers] }) })
  afterAll(async () => { await ui.unmount() })
  const where = { machine: 'local', thread: thread(servers) }
  type Call = { name: string; arguments: Record<string, unknown> } & Partial<Pick<ToolRowCall, 'state' | 'result'>>
  const call = (name: string, args: Record<string, unknown>, more: Partial<Call> = {}): Call => ({ name, arguments: args, ...more })
  /** A call's row as the transcript draws it, as HTML. */
  const row = async (c: Call) => {
    const drawn = await ui.render({ tool: c, thread: where.thread })
    const markup = drawn.container.innerHTML
    await drawn.unmount()
    return markup
  }

  it("draws an MCP call: the plug, the verb, the server and tool, what it's about; open, its arguments, result and images", async () => {
    const done = await row(call('mcp__linear__create_issue', { title: 'Fix login', body: 'long\ntext' }, {
      result: { text: 'Created ENG-1', isError: false, details: { server: 'linear', tool: 'create_issue', title: 'Create issue', serverTitle: 'Linear' }, images: [{ data: 'AAAA', mimeType: 'image/png' }] },
    }))
    expect(done).toContain('>Called<')
    expect(done).toContain('Linear · Create issue')
    expect(done).toContain('Fix login')
    expect(done).toMatch(/<summary>.*Arguments<\/summary>/)
    expect(done).toContain('Created ENG-1')
    expect(done).toContain('src="data:image/png;base64,AAAA"')
    // Before its result, by its name, the server's title from the thread.
    const running = await row(call('mcp__linear__list_issues', {}, { state: 'working' }))
    expect(running).toContain('>Calling<')
    expect(running).toContain('Linear · list_issues')
    expect(running).not.toContain('Arguments')
    const failed = await row(call('mcp__github__get_me', {}, { state: 'error', result: { text: 'github needs you to sign in again', isError: true } }))
    expect(failed).toContain('>Failed<')
    expect(failed).toContain('github · get_me')
    expect(failed).toContain('github needs you to sign in again')
    const cut = await row(call('mcp__linear__create_issue', {}, { state: 'error', result: { text: 'linear.create_issue was running when Superego stopped.', isError: true, details: { server: 'linear', tool: 'create_issue', interrupted: true } } }))
    expect(cut).toContain('Interrupted: may have run')
    expect(cut).not.toContain('>Failed<')
    // Only by its details, whatever its text says.
    expect(await row(call('mcp__linear__create_issue', {}, { state: 'error', result: { text: 'linear.create_issue was running when Superego stopped.', isError: true } }))).toContain('>Failed<')
    // A run of them, in a line.
    expect(ui.describeRun(['mcp__linear__a', 'mcp__linear__b', 'read'], where)).toEqual(['Called 2 MCP tools and read a file'])
  })

  it('draws a tool search: what it looked for, and what it loaded', async () => {
    const searched = await row(call('tool_search', { query: 'issue' }, { result: { text: 'Loaded 2 tools.', isError: false, details: { loaded: ['mcp__linear__create_issue', 'mcp__linear__list_issues'] } } }))
    expect(searched).toContain('Looked for tools')
    expect(searched).toContain('“issue”')
    expect(searched).toContain('2 loaded')
    expect(searched).toContain('Linear · <code>create_issue</code>')
    expect(await row(call('tool_search', { query: 'zzz' }, { result: { text: 'No matching tools found.', isError: false, details: { loaded: [] } } }))).toContain('none found')
  })

  it("shows a thread's servers in its header and details, and why any were left out", async () => {
    const chip = html(createElement(Chip, { place: 'header', machine, thread: where.thread }))
    expect(chip).toContain('2 servers')
    expect(chip).toContain('is-troubled')
    expect(html(createElement(Chip, { place: 'header', machine, thread: thread() }))).toBe('')
    const drawn = await ui.render({ slot: 'details.section', thread: where.thread })
    const details = drawn.container.innerHTML
    await drawn.unmount()
    expect(details).toContain('<h5>MCP servers</h5>')
    expect(details).toContain('Linear')
    expect(details).toContain('Running · 23 tools')
    expect(details).toContain('Needs sign-in')
    expect(details).toContain('Set its key')
    expect(details).toContain('Left out: no such server here')
    // None for a thread that goes without the extension.
    await expect(ui.render({ slot: 'details.section', thread: { ...where.thread, without: ['mcp-servers'] } })).rejects.toThrow(/Nothing fills details.section/)
  })

  it('asks the user to sign in, or to set a key', () => {
    const notice = (server: ServerInfo) => html(createElement(NoticeFor, { machine, server, onOpen() {}, onDismiss() {} }))
    expect(notice(info({ state: 'needs-sign-in' }))).toContain('Linear needs you to sign in.')
    expect(notice(info({ state: 'needs-sign-in' }))).toContain('>Sign in<')
    const keyed = notice(info({ name: 'github', config: { url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'api-key' } }, state: 'needs-sign-in', secrets: [{ name: 'key', set: false }] }))
    expect(keyed).toContain('github needs its key set.')
    expect(keyed).toContain('>Set key<')
  })

  it("draws a server's row in Settings: its state, what it needs, and Allow with the whole command", () => {
    const rowOf = (server: ServerInfo, own = true) => html(createElement(ServerRow, { server, own, run() {}, onEdit() {}, onLog() {}, onHelp() {} }))
    const running = rowOf(info())
    expect(running).toContain('mcp.linear.app')
    expect(running).toContain('Running · 23 tools')
    expect(running).toContain('aria-label="Use in threads without a profile"')
    expect(running).not.toContain('Sign in')
    const signedIn = rowOf(info({ oauth: { signedIn: true, since: Date.now() - 3 * 86_400_000, refreshes: true, scope: 'read' } }))
    expect(signedIn).toContain('Running · 23 tools · <span title="Signed in ')
    expect(signedIn).toContain('Scope: read">Signed in 3 days ago</span>')
    expect(rowOf(info({ state: 'needs-sign-in' }))).toContain('>Sign in<')
    expect(rowOf(info({ state: 'needs-sign-in', config: { command: 'npx', auth: { type: 'env', names: ['T'] } }, secrets: [{ name: 'T', set: false }] }))).toContain('>Set key<')
    const failed = rowOf(info({ state: 'failed', error: 'exited with code 1: boom' }))
    expect(failed).toContain('exited with code 1: boom')
    expect(failed).toContain('>Show log<')
    const waiting = rowOf(info({ name: 'docs', state: 'waiting', runs: 'npx -y docs-mcp', config: { command: 'npx', args: ['-y', 'docs-mcp', '--root', '/a b'], env: { MODE: 'ro' }, allowed: false } }))
    expect(waiting).toContain('Added by Ego')
    expect(waiting).toContain(`MODE=ro npx -y docs-mcp --root &#x27;/a b&#x27;`)
    expect(waiting).toContain('>Allow<')
    // A profile's: not the switch (it's the profile's to say), and where it's from.
    const profiled = rowOf(info({ id: '/p/.superego/profiles/default#docs', name: 'docs', from: { type: 'profile', profile: 'default', scope: 'project', dir: '/p/.superego/profiles/default', project: '/p' } }), false)
    expect(profiled).not.toContain('Use in threads without a profile')
    expect(profiled).toContain('profile <b>default</b> in /p')
    expect(profiled).not.toContain('not loaded yet')
    // From the cache, before its profile loads again: it says so.
    const cached = rowOf(info({ name: 'docs', state: 'stopped', profileAllowed: false, from: { type: 'profile', profile: 'default', scope: 'project', dir: '/p/.superego/profiles/default', project: '/p' } }), false)
    expect(cached).toContain('profile <b>default</b> in /p, not loaded yet')
  })
})

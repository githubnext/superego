// @vitest-environment happy-dom
// Claude Agent in the window, drawn whole over a real daemon with a fake `claude` (never anyone's sign-in): its group in
// the New thread dialog's model menu, which asks for a thread on it with the claude profile; and Settings → Claude Agent,
// saying what Claude Code is there (found and signed in, signed out with a terminal to sign in, not installed).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { arr, obj, str } from '@earendil-works/pi-schema'
import { defineAction, defineDaemonExtension } from '@superego/daemon'
import type { ActionLogEntry } from '@superego/protocol'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import { claudeAgent } from '../src/daemon.ts'
import { CLAUDE } from '../src/shared.ts'
import claudeAgentUi from '../src/ui.tsx'

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

let dir: string | undefined
let daemon: TestDaemon | undefined
let ui: TestWindow | undefined
afterEach(async () => {
  await ui?.unmount()
  ui = undefined
  await daemon?.close()
  daemon = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A `claude` saying it's `version`, and `status` to `auth status`; none at all for undefined. */
function fakeClaude(status: object | undefined) {
  dir = mkdtempSync(join(tmpdir(), 'superego-claude-window-'))
  if (!status) return undefined
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/bash\n[ "$1" = "--version" ] && echo '2.1.325 (Claude Code)'\n[ "$1 $2" = "auth status" ] && echo '${JSON.stringify(status)}'\nexit 0\n`)
  chmodSync(file, 0o755)
  return file
}

/** The terminal's action, standing in: what it was asked to run. */
const ran: unknown[] = []
const terminal = defineDaemonExtension({
  name: 'terminal', setup(superego) {
    superego.action(defineAction({ id: 'terminal.run', title: 'Run', params: obj({ thread: str(), command: arr(str()) }), run: (params) => { ran.push(params); return { id: 'p1' } } }))
  },
})

async function open(status: object | undefined) {
  const claude = fakeClaude(status)
  daemon = await testDaemon({ model: 'echo', extensions: [claudeAgent({ executable: async () => claude }), terminal] })
  // Once it has looked at Claude Code, as it does as it starts: a model menu waits only 3s for that, which a busy
  // machine's `claude` can take longer than.
  await (await daemon.watch(CLAUDE)).until((check) => check !== null, 'Claude Code looked at')
  // Once it has looked at Claude Code, as it does as it starts: a model menu waits only 3s for that, which a busy
  // machine's `claude` can take longer than.
  await (await daemon.watch(CLAUDE)).until((check) => check !== null, 'Claude Code looked at')
  ui = await mountUi({ window: true, machines: [daemon], extensions: [claudeAgentUi] })
  return claude
}

it("offers Claude Agent's models in the New thread dialog, and starts a thread on one with the claude profile", async () => {
  await open({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
  await ui!.key('mod+n')
  await ui!.until(() => !$<HTMLElement>('.new-thread [aria-label="Model"]')?.hasAttribute('data-disabled') && $('.new-thread [aria-label="Model"]')?.textContent !== 'Loading…', 'the models')
  $('.new-thread [aria-label="Model"]')!.click()
  await ui!.until(() => $$('.model-picker__heading').some((h) => h.textContent?.startsWith('Claude Agent')), 'the Claude Agent group')
  const heading = $$('.model-picker__heading').find((h) => h.textContent?.startsWith('Claude Agent'))!
  expect(heading.textContent).toBe('Claude AgentRuns your Claude Code')
  const rows = () => $$('.model-picker__item').map((row) => row.textContent)
  expect(rows()).toEqual(expect.arrayContaining(['Opus', 'Sonnet', 'Haiku']))
  $$('.model-picker__item').find((row) => row.textContent === 'Sonnet')!.click()
  await ui!.until(() => $('.new-thread [aria-label="Model"]')?.textContent === 'Claude Agent · Sonnet', 'Sonnet picked')
  // The profile that runs on it is picked with it.
  expect($<HTMLSelectElement>('.new-thread select[aria-label="Profile"]')?.value ?? $('.new-thread [aria-label="Profile"]')?.textContent).toContain('claude')
  $$('.new-thread__foot button').find((b) => b.textContent?.startsWith('Start'))!.click()
  // It asks for that model with that profile (a happy-dom test can't load a profile's module, so the daemon's side,
  // starting it, is daemon.test.ts's).
  await ui!.until(async () => (await daemon!.call<ActionLogEntry[]>('action.log', {})).some((e) => e.id === 'thread.start'), 'started')
  const asked = (await daemon!.call<ActionLogEntry[]>('action.log', {})).find((e) => e.id === 'thread.start')!
  expect(asked.params).toMatchObject({ model: 'claude-agent/sonnet', profile: 'claude' })
})

it("doesn't let Claude Agent's models be picked while Claude Code isn't signed in, saying so", async () => {
  await open({ loggedIn: false, authMethod: 'none' })
  await ui!.key('mod+n')
  await ui!.until(() => $('.new-thread [aria-label="Model"]')?.textContent !== 'Loading…', 'the models')
  $('.new-thread [aria-label="Model"]')!.click()
  await ui!.until(() => $$('.model-picker__heading').some((h) => h.textContent?.startsWith('Claude Agent')), 'the Claude Agent group')
  expect($$('.model-picker__heading').find((h) => h.textContent?.startsWith('Claude Agent'))!.textContent).toContain("Claude Code isn't signed in here: run claude, then /login")
  expect($$('.model-picker__item.is-unavailable').map((row) => row.textContent)).toEqual(['Opus', 'Sonnet', 'Haiku'])
})

it("makes Claude Code the machine's default when it's used in setup: ⌘N then starts on it, with the claude profile", async () => {
  await open({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
  await ui!.registry.router.dispatch('app.setup')
  // The scripted model works already: setup opens on it, and Claude Code is among what's found once another is asked for.
  await ui!.until(() => Boolean($('.setup__another')), 'setup, on the model that works')
  $('.setup__another')!.click()
  const claude = () => $$('.setup__row').find((r) => r.querySelector('.setup__what')?.firstElementChild?.textContent === 'Claude Code')
  await ui!.until(() => Boolean(claude()?.querySelector('button')), 'Claude Code found')
  expect(claude()!.textContent).toContain('Signed in with your Claude Max plan · experimental')
  claude()!.querySelector('button')!.click()
  await ui!.until(() => Boolean($('.setup')?.textContent?.includes('New threads run on your Claude Code')), 'Claude Code used')
  // Named as it was found, saying once that it's experimental.
  expect($('.setup__rows .setup__what')!.textContent).toBe('Claude CodeSigned in with your Claude Max plan · experimental')
  expect($('.setup__models .setup__note')!.textContent).toBe('New threads run on your Claude Code.')
  expect((await daemon!.call<{ default: { model?: string } }>('agent.models', {})).default.model).toBe('claude-agent/opus')
  expect($('.setup__model.is-default')?.textContent).toContain('Opus')

  // Start a thread: ⌘N says it runs on Claude Code, and asks for no model or profile of its own (the default is it).
  $$('.setup__foot button').find((b) => b.textContent === 'Start a thread')!.click()
  await ui!.until(() => $('.new-thread [aria-label="Model"]')?.textContent === 'Default · Opus', "⌘N on the default, Claude Code's Opus")
  expect($<HTMLSelectElement>('.new-thread select[aria-label="Profile"]')!.value).toBe('claude')
  $$('.new-thread__foot button').find((b) => b.textContent?.startsWith('Start'))!.click()
  await ui!.until(async () => (await daemon!.call<ActionLogEntry[]>('action.log', {})).some((e) => e.id === 'thread.start'), 'started')
  const asked = (await daemon!.call<ActionLogEntry[]>('action.log', {})).find((e) => e.id === 'thread.start')!
  expect(asked.params).not.toHaveProperty('model')
  expect(asked.params).not.toHaveProperty('profile')
})

/** Settings, on this machine's tab, once Claude Agent's section says what's there. */
async function settings(what: string) {
  $('.app__settings')!.click()
  // At this machine's tab, once it's there: the machines come after the window's own.
  const tab = () => $$('.settings__nav [role="tab"]').find((b) => b.textContent?.includes('local'))
  await ui!.until(() => Boolean(tab()), "Settings, with this machine's tab")
  tab()!.click()
  await ui!.until(() => Boolean($('.claude-agent-settings')?.textContent?.includes(what)), what)
  return $('.claude-agent-settings')!.closest('.settings-section')!.textContent ?? ''
}

it('shows Claude Code in Settings: its version, where it is and the plan it is signed in with', async () => {
  const claude = await open({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
  const text = await settings('Signed in with your Claude Max plan')
  expect(text).toContain('Claude Code 2.1.325')
  expect(text).toContain(claude)
  expect(text).toContain('Permission mode')
  expect(text).toContain('Threads at once')
  expect(text).not.toContain('Open a terminal')
})

it('says how to sign in when Claude Code is signed out, and opens it in a terminal beside a thread there', async () => {
  const claude = await open({ loggedIn: false, authMethod: 'none' })
  const thread = await daemon!.thread()
  const text = await settings('Not signed in')
  expect(text).toContain('Run claude and /login in a terminal.')
  ran.length = 0
  $$('.claude-agent-settings button').find((b) => b.textContent === 'Open a terminal')!.click()
  await ui!.until(() => ran.length === 1 && !$('.settings'), 'the terminal opened, and the thread shown')
  expect(ran).toEqual([{ thread: thread.id, command: [claude] }])
})

it("says when Claude Code isn't installed", async () => {
  await open(undefined)
  expect(await settings("Claude Code isn't installed here")).toContain('code.claude.com')
})

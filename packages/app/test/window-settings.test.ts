// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
// Settings in the window drawn whole (superego/testing's mountUi) over a real daemon: the app's settings on three tabs
// (General, Appearance, Hotkeys; an extension's under General unless it names another), a link into a machine's
// Providers landing on its tab, a shortcut recorded for an action (the old one stops, the new one runs it, a clash
// shows, Reset all), the accent colour and fonts applied, and a provider signed in with an API key (a wrong one refused,
// as it's tried first) and out again.
import { createServer } from 'node:http'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineUiExtension } from '../src/renderer/sdk-ui.ts'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const css = (variable: string) => document.documentElement.style.getPropertyValue(variable)

const tab = (title: string) => $$('.settings__nav [role="tab"]').find((t) => t.textContent?.trim() === title)
const headings = () => $$('.settings__content h2').map((h) => h.textContent)
/** Open a tab of Settings, once its sections have loaded. */
const go = async (title: string) => {
  tab(title)!.click()
  await ui.until(() => Boolean(tab(title)?.hasAttribute('data-active')) && !$('.settings__content')?.textContent?.includes('Loading…'), title)
}

// An app extension with settings of its own: one section left to General, one on Appearance.
const extension = defineUiExtension({
  name: 'moonlit', title: 'Moonlit',
  setup(superego) {
    superego.appSettings({ id: 'moonlit', title: 'Moonlit', settings: [{ key: 'moonlit.howl', title: 'Howl', default: false, type: 'boolean' }] })
    superego.appSettings({ id: 'moonlit-glow', title: 'Glow', tab: 'appearance', settings: [{ key: 'moonlit.glow', title: 'Glow at night', default: true, type: 'boolean' }] })
  },
})

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => {
  daemon = await testDaemon({ model: 'echo' })
  ui = await mountUi({ window: true, machines: [daemon], extensions: [extension] })
  $('.app__settings')!.click()
  await ui.until(() => Boolean(tab('General')?.hasAttribute('data-active')) && headings().length > 0, 'Settings, on General')
})
afterEach(async () => { await ui.unmount(); await daemon.close() })

it('splits the app’s settings over General, Appearance and Hotkeys, an extension’s under General unless it says', async () => {
  expect($$('.settings__nav [role="tab"]').map((t) => t.textContent?.trim()).slice(0, 4)).toEqual(['General', 'Appearance', 'Hotkeys', 'Machines'])
  // General: everything that isn't Appearance or Hotkeys, the extension's own among it.
  await ui.until(() => headings().includes('Moonlit'), 'the extension’s settings under General')
  expect(headings()).toContain('Notifications')
  expect(headings()).not.toContain('Appearance')
  expect(headings()).not.toContain('Glow')
  expect($('[data-key="app.font.interface"]')).toBeNull()
  expect($('.keymap')).toBeNull()

  // Appearance: its settings, under no heading saying it again, and the section that asked to be there.
  await go('Appearance')
  await ui.until(() => Boolean($('[data-key="app.font.interface"]') && $('[data-key="app.theme.light"]') && $('[data-key="app.layout"]') && $('[data-key="moonlit.glow"]')), 'Appearance’s settings')
  expect(headings()).toEqual(['Glow'])
  expect($('[data-key="moonlit.howl"]')).toBeNull()

  // Hotkeys: the shortcuts alone.
  await go('Hotkeys')
  await ui.until(() => Boolean($('.keymap [data-action="app.sidebar"]')), 'the shortcuts')
  expect(headings()).toEqual([])
  expect($('[data-key="app.font.interface"]')).toBeNull()
})

it('opens on the tab a link names, from whichever it was left on', async () => {
  await go('Hotkeys')
  // Setup's way to the providers it doesn't list: Settings, at the machine's Providers.
  await ui.dispatch('app.setup')
  await ui.until(() => $$('button').some((b) => b.textContent === 'Add another provider'), 'setup, on the model that works')
  $$('button').find((b) => b.textContent === 'Add another provider')!.click()
  await ui.until(() => $$('button').some((b) => b.textContent === 'Another provider'), 'setup’s ways in')
  $$('button').find((b) => b.textContent === 'Another provider')!.click()
  await ui.until(() => Boolean($('.settings__nav-machine[data-active]')?.textContent?.includes('local')) && Boolean($('.provider')), 'the machine’s Providers')
})

it('records a shortcut for an action: a bare key refused, the old one off, the new one on, a clash shown, all reset', async () => {
  await go('Hotkeys')
  const keys = (id: string) => $(`[data-action="${id}"] .keymap__keys`)
  // Whether the window keeps its sidebar hidden: what app.sidebar changes, Settings being in front of it.
  const hidden = () => Object.entries(localStorage).some(([key, value]) => key.endsWith('sidebar.open') && value === 'false')
  await ui.until(() => /^(⌘|Ctrl\+)\/$/.test(keys('app.sidebar')?.textContent ?? ''), 'the sidebar’s shortcut listed')
  keys('app.sidebar')!.focus()
  keys('app.sidebar')!.click()
  await ui.until(() => Boolean(keys('app.sidebar')?.classList.contains('is-recording')), 'recording')
  await ui.key('k')
  await ui.until(() => Boolean(keys('app.sidebar')?.textContent?.includes('typing stays typing')), 'a bare key refused')
  await ui.key('mod+shift+r')
  await ui.until(() => /⇧R|Shift\+R/.test(keys('app.sidebar')?.textContent ?? '') && Boolean($('[data-action="app.sidebar"] button.keymap__reset')), 'the new shortcut recorded')
  await ui.key('mod+/')
  expect(hidden()).toBe(false)
  await ui.key('mod+shift+r')
  await ui.until(hidden, 'the new shortcut runs the action')
  await ui.key('mod+shift+r')
  await ui.until(() => !hidden(), 'and back')
  await ui.dispatch('app.settings.set', { key: 'app.keys', value: { 'app.sidebar': 'mod+shift+r', 'app.palette': 'mod+shift+r' } })
  await ui.until(() => Boolean($('[data-action="app.sidebar"] .keymap__clash')?.textContent?.includes('Commands')), 'the clash shown')
  $$('.keymap__head button').find((b) => b.textContent === 'Reset all')!.click()
  await ui.until(() => !$('.keymap__clash') && Boolean(keys('app.sidebar')?.textContent?.includes('/')), 'reset to the actions’ own')
})

it('applies the accent colour and the fonts, and resets the accent', async () => {
  await go('Appearance')
  const accent = () => $('[data-key="app.accent"] .color-field input:not([type=color])') as HTMLInputElement
  await ui.until(() => accent()?.value === 'color(display-p3 0.155 0.319 0.654)', 'the accent shown')
  await ui.type('[data-key="app.accent"] .color-field input:not([type=color])', 'oklch(0.6 0.2 30)')
  accent().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await ui.until(() => css('--superego-accent-base') === 'oklch(0.6 0.2 30)', 'the accent applied')
  $$('[data-key="app.accent"] button').find((b) => b.textContent === 'Reset')!.click()
  await ui.until(() => css('--superego-accent-base').startsWith('color(display-p3'), 'the accent reset')
  await ui.dispatch('app.settings.set', { key: 'app.font.mono', value: 'Menlo' })
  await ui.until(() => css('--superego-mono').includes('Menlo'), 'the mono font applied')
})

it('signs a provider in with an API key, tried first, puts the flow away, and signs it out', async () => {
  // An OpenAI-compatible provider that takes one key: a chat with any other is refused as OpenAI does.
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.headers.authorization !== 'Bearer good-key') {
        response.writeHead(401, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }))
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await daemon.call('providers.save', { name: 'Mock', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: ['m'] })
    $$('.settings__nav button').find((b) => b.textContent?.includes('local'))!.click()
    const mock = () => $$('.provider').find((p) => p.textContent?.startsWith('Mock'))!
    const button = (label: string) => [...mock().querySelectorAll('button')].find((b) => b.textContent === label)
    const signIn = async (key: string) => {
      button('API key…')!.click()
      await ui.until(() => Boolean(mock().querySelector('input[name="key"]')), "a provider's API key field")
      await ui.type('.provider input[name="key"]', key)
      ;(mock().querySelector('input[name="key"]') as HTMLInputElement).form!.requestSubmit()
    }
    await ui.until(() => Boolean($$('.provider').length && button('API key…')), 'the providers')
    await signIn('wrong-key')
    await ui.until(() => Boolean($('.auth-flow')?.textContent?.includes('Mock rejected the API key')), 'a wrong key refused')
    expect(button('Sign out')).toBeUndefined()
    $$('.auth-flow button').find((b) => b.textContent === 'Close')!.click()
    await signIn('good-key')
    await ui.until(() => Boolean($('.auth-flow')?.textContent?.includes('Signed in.')) && Boolean(button('Sign out')), 'signed in with an API key')
    $$('.auth-flow button').find((b) => b.textContent === 'Close')!.click()
    await ui.until(() => !$('.auth-flow'), 'the sign-in put away')
    button('Sign out')!.click()
    await ui.until(() => !button('Sign out'), 'signed out again')
  } finally { server.close() }
})

it('goes through its sections as tabs: the arrow keys move down the list, a click opens one', async () => {
  const tabs = () => $$('.settings__nav [role="tab"]')
  expect($('.settings__nav')!.getAttribute('role')).toBe('tablist')
  expect(tabs().map((t) => t.getAttribute('aria-selected'))[0]).toBe('true')
  tabs()[0]!.focus()
  tabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await ui.until(() => document.activeElement === tabs()[1], 'Appearance focused')
  tabs()[3]!.click()
  await ui.until(() => tabs()[3]!.hasAttribute('data-active') && $('.settings__content')?.getAttribute('role') === 'tabpanel', 'Machines open')
})

it('opens each tab at its top, not scrolled as the last one was', async () => {
  const general = $('.settings__content')!
  general.scrollTop = 400
  await go('Appearance')
  expect($('.settings__content')).not.toBe(general)
  expect($('.settings__content')!.scrollTop).toBe(0)
})

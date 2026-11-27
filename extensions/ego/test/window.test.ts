// @vitest-environment happy-dom
// Ego in the window, over a real daemon: its word on first-run setup (what to ask it for, where it is, a way in), the
// rail's button breathing meanwhile; gone when Ego is switched off there.
import { afterEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import { ego } from '../src/daemon.ts'
import egoUi from '../src/ui.tsx'
import type { SettingsSnapshot } from '@superego/protocol'

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

let daemon: TestDaemon | undefined
let ui: TestWindow | undefined
afterEach(async () => {
  await ui?.unmount()
  ui = undefined
  await daemon?.close()
  daemon = undefined
})

it('says on setup what to ask Ego for and where it is, beckons from the rail, and opens it', async () => {
  daemon = await testDaemon({ model: 'echo', extensions: [ego()] })
  ui = await mountUi({ window: true, machines: [daemon], extensions: [egoUi] })
  await ui.registry.router.dispatch('app.setup')
  // On the model that works, with the welcome and the extensions' switches after it (there while it looks, too).
  await ui.until(() => Boolean($('.setup__bubble')) && Boolean($('.ego__welcome')), 'the model saying hi, and the welcome')
  expect($('.ego__welcome p')!.textContent).toBe('Tell Superego test what you want — a tool, a pane, a board — and it builds it for you. It lives at the top of the rail.')
  expect($('.setup__extensions')).not.toBeNull()
  expect($('.ego__button')!.classList.contains('ego__button--beckon')).toBe(true)

  $$('.ego__welcome button').find((b) => b.textContent === 'Open Superego test')!.click()
  await ui.until(() => !$('.setup'), 'setup put away for Ego')
  expect($('.ego__button')!.classList).toContain('is-on')
  expect($('.ego__button')!.classList.contains('ego__button--beckon')).toBe(false)
})

it('goes from setup when Ego is switched off there', async () => {
  daemon = await testDaemon({ model: 'echo', extensions: [ego()] })
  ui = await mountUi({ window: true, machines: [daemon], extensions: [egoUi] })
  await ui.registry.router.dispatch('app.setup')
  await ui.until(() => Boolean($('.ego__welcome')), 'the welcome')
  $$('.setup__extensions .setup__link').find((b) => b.textContent?.startsWith('Show all'))!.click()
  await ui.until(() => Boolean($('[data-extension="ego"] [role="switch"]')), 'the switches')
  $('[data-extension="ego"] [role="switch"]')!.click()
  await ui.until(() => !$('.ego__welcome'), 'the welcome gone')
  expect((await daemon.call<{ value: SettingsSnapshot }>('settings.watch', {})).value.values['extensions.ego']).toBe(false)
  expect($('[data-extension="ego"] [role="switch"]')!.getAttribute('aria-checked')).toBe('false')
})

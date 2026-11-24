// @vitest-environment happy-dom
// A secret in Settings, drawn whole (superego/testing's mountUi) over a real daemon: set from a masked field, shown only
// as Set (the window never has its value back), replaced, and cleared, each reaching the extension that asked for it.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineDaemonExtension } from '@superego/daemon'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

const vault = defineDaemonExtension({
  name: 'vault', api: '^5.8',
  setup(superego) {
    superego.settings.register({ id: 'vault', title: 'Vault', settings: [{ key: 'vault.token', title: 'Vault token', type: { type: 'secret', placeholder: 'tok-…' } }] })
    superego.method('vault.token', async () => (await superego.secrets.get('vault.token')) ?? null)
  },
})

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => {
  daemon = await testDaemon({ model: 'echo', extensions: [vault] })
  ui = await mountUi({ window: true, machines: [daemon] })
  $('.app__settings')!.click()
  // At this machine's tab, once it's there: the machines come after the window's own.
  const tab = () => $$('.settings__nav button').find((b) => b.textContent?.includes('local'))
  await ui.until(() => Boolean(tab()), "Settings, with this machine's tab")
  tab()!.click()
})
afterEach(async () => { await ui.unmount(); await daemon.close() })

it('sets, replaces and clears a secret from its section, never showing it again', async () => {
  const row = () => $('[data-key="vault.token"]')
  const button = (label: string) => [...row()?.querySelectorAll('button') ?? []].find((b) => b.textContent === label)
  await ui.until(() => Boolean(row()?.querySelector('input[type="password"]')), 'the secret’s field')
  expect((row()!.querySelector('input') as HTMLInputElement).placeholder).toBe('tok-…')
  await ui.type('[data-key="vault.token"] input', 'first-token')
  button('Save')!.click()
  await ui.until(() => Boolean(row()?.textContent?.includes('Set')) && !row()?.querySelector('input'), 'shown as set')
  expect(await daemon.call('vault.token')).toBe('first-token')
  expect(document.body.innerHTML).not.toContain('first-token')

  button('Replace')!.click()
  await ui.until(() => Boolean(row()?.querySelector('input[type="password"]')), 'a field to replace it')
  await ui.type('[data-key="vault.token"] input', 'second-token')
  button('Save')!.click()
  await ui.until(() => Boolean(button('Clear')), 'set again')
  expect(await daemon.call('vault.token')).toBe('second-token')

  button('Clear')!.click()
  await ui.until(() => Boolean(row()?.querySelector('input[type="password"]')) && !button('Clear'), 'cleared')
  expect(await daemon.call('vault.token')).toBe(null)
})

// @vitest-environment happy-dom
// First run in the window drawn whole (superego/testing's mountUi) over a fresh daemon: setup opening by itself, once
// the machine says it isn't onboarded, doesn't take Settings away from a user who opened it first; it's there behind.
import { afterEach, expect, it } from 'vitest'
import { daemonMachine, mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)

let daemon: TestDaemon
let ui: TestWindow
afterEach(async () => { await ui.unmount(); await daemon.close() })

it('keeps Settings open when first-run setup comes after it, and shows setup once Settings closes', async () => {
  daemon = await testDaemon({ model: 'echo' })
  // The machine's settings held back until Settings is open: setup learns it's a first run only then.
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const machine = daemonMachine(daemon)
  const call = machine.call.bind(machine)
  let answered = false
  ui = await mountUi({
    window: true,
    machines: [{
      ...machine,
      call: async (method: string, params: unknown) => {
        if (method !== 'settings.watch') return call(method, params)
        await held
        try { return await call(method, params) } finally { answered = true }
      },
    }],
  })
  $('.app__settings')!.click()
  await ui.until(() => Boolean($('.settings__nav')), 'Settings')
  release()
  await ui.until(() => answered, "the machine's settings")
  await ui.settle()
  expect($('.settings__nav')).not.toBeNull()

  await ui.key('escape')
  await ui.until(() => !$('.settings__nav') && Boolean($('.app__main')?.textContent?.includes('Welcome to')), 'setup, once Settings closed')
})

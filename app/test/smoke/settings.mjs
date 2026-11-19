// Settings as only the desktop app has them: the installed fonts, machines over ssh and through a command, the menu bar
// and the Dock, and a restart onto new daemon code. (Keyboard, the accent, a provider's key: window-settings.test.ts.)
import { home, restartOntoNewCode, STRAY } from './common.mjs'
import { writeFileSync } from 'node:fs'

export default async function settings(t, s) {
  await t.click('.app__settings')
  await t.until(`document.querySelector('.settings')?.textContent.includes('Appearance') && document.querySelector('.settings').textContent.includes('Notifications')`, 'app settings')
  // Fonts: the picker lists installed families (the harness's, here; it needs a user gesture), and a choice sets the
  // CSS variable.
  await t.run(`document.querySelector('[data-key="app.font.interface"] .superego-font-picker__button').click()`, true)
  await t.until(`document.querySelectorAll('.superego-font-picker__item').length > 5`, 'installed fonts listed')
  // Typing highlights the first match; Enter picks it.
  await t.type('.superego-font-picker__popover input.superego-field', 'Arial')
  await t.until(`document.querySelector('.superego-font-picker__item[data-highlighted]')?.textContent === 'Arial'`, 'first match highlighted')
  t.key('Enter', [])
  await t.until(`/Arial/.test(document.documentElement.style.getPropertyValue('--superego-font'))`, 'interface font applied')
  await t.call('app.settings.set', { key: 'app.font.mono', value: 'Menlo' }, 'app')
  await t.until(`document.documentElement.style.getPropertyValue('--superego-mono').includes('Menlo')`, 'mono font applied')

  // Machines: add one over ssh that can't connect; it shows its error, then goes away again.
  await t.click('.settings__nav button', 'Machines')
  await t.call('machine.add', { label: 'Nowhere', target: 'superego-smoke.invalid' }, 'app')
  await t.until(`[...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('superego-smoke.invalid') && /disconnected/.test(row.textContent))`, 'ssh machine listed with its error')
  await t.run(`(async () => { const list = await window.superego.machines(); await window.superego.call('app', 'machine.remove', { id: list.find((m) => m.label === 'Nowhere').id }) })()`)
  await t.until(`![...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('superego-smoke.invalid'))`, 'machine removed')
  // A second machine: another daemon, reached through a command that pipes stdio to it (as docker exec would).
  const via = `SUPEREGO_HOME='${home}/second' SUPEREGO_MODEL=faux node '${new URL('../../bin/superego.ts', import.meta.url).pathname}' connect --start`
  await t.call('machine.add', { label: 'Second', via }, 'app')
  await t.until(`[...document.querySelectorAll('.machine-row')].some((row) => row.querySelector('input')?.value === 'Second' && / · connected/.test(row.textContent))`, 'second machine connected', 30_000)
  // All machines: a disagreement shows as Mixed, and one change reaches both.
  await t.call('settings.set', { key: 'agent.model', value: 'faux/faux-1' })
  await t.click('.settings__nav button', 'All machines')
  await t.until(`document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'mixed model across machines')
  await t.run(`(() => {
    const select = document.querySelector('[data-key="agent.model"] select')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'faux/faux-1')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await t.until(`!document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'model set on all machines')
  s.second = await t.run(`window.superego.machines().then((list) => list.find((m) => m.label === 'Second').id)`)
  const secondModel = await t.run(`window.superego.call('${s.second}', 'settings.watch', {}).then((r) => r.value.values['agent.model'])`)
  if (secondModel !== 'faux/faux-1') t.fail(`second machine model is ${secondModel}`)
  await t.until(`window.superego.machines().then((list) => list.filter((m) => m.state === 'connected').length === 2)`, 'both machines connected')
  await t.run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await t.until(`document.querySelector('.settings')?.textContent.includes('Providers') && [...document.querySelectorAll('[data-key="agent.model"] option')].some((o) => o.value === 'faux/faux-1')`, "this computer's settings, with its model choices")

  // The menu bar: on by default; "Hide Dock icon" needs it; turning it off takes the item away.
  const desktop = () => t.call('app.desktop', {}, 'app')
  if (!(await desktop()).menuBar) t.fail('menu bar item not up by default')
  await t.call('app.settings.set', { key: 'app.hideDock', value: true }, 'app')
  if (process.platform === 'darwin' && !(await desktop()).dockHidden) t.fail('dock not hidden')
  await t.call('app.settings.set', { key: 'app.menuBar', value: false }, 'app')
  await t.until(`window.superego.call('app', 'app.desktop', {}).then((d) => !d.menuBar && !d.dockHidden)`, 'menu bar off, dock back')
  const refused = await t.run(`window.superego.call('app', 'app.settings.set', { key: 'app.hideDock', value: true }).then(() => 'set', (e) => e.message)`)
  if (process.platform === 'darwin' && !/menu bar/.test(refused)) t.fail(`hide dock without menu bar: ${refused}`)
  await t.call('app.settings.set', { key: 'app.menuBar', value: true }, 'app')

  // Restart: new daemon code on disk (faked with an extra file in the build) shows "Restart required"; restarting
  // brings up a daemon of that build, with the threads still there.
  await restartOntoNewCode(t, () => writeFileSync(STRAY, '// smoke\n'))
  // The dialog: Escape in the font picker closes only the picker; the next Escape closes Settings.
  await t.click('.settings__nav button', 'General')
  await t.until(`Boolean(document.querySelector('[data-key="app.font.mono"]'))`, 'general pane')
  await t.run(`document.querySelector('[data-key="app.font.mono"] .superego-font-picker__button').click()`, true)
  await t.until(`document.activeElement?.placeholder === 'Search fonts'`, 'picker focused')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.superego-font-picker__popover') && Boolean(document.querySelector('.settings'))`, 'picker closed, dialog open')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.settings')`, 'dialog closed by Escape')
}

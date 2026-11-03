// Headless end-to-end: the real app, the real daemon (scripted model), driven through the renderer.
// Phase "first" creates a session and chats; phase "reopen" is a fresh app process that must find it on the same
// daemon, which outlived the first app. Run by test/smoke.sh.
import { app, BrowserWindow } from 'electron'

const phase = process.env.MU_SMOKE_PHASE ?? 'first'
import { readFileSync } from 'node:fs'
const fail = async (message) => {
  console.error(`smoke(${phase}): FAIL ${message}`)
  const window = BrowserWindow.getAllWindows()[0]
  if (window) console.error('POPOVER:', await window.webContents.executeJavaScript(`document.querySelector('.mu-font-picker__popover')?.textContent ?? 'none'`).catch(String))
  if (window) console.error('ROWS:', await window.webContents.executeJavaScript(`[...document.querySelectorAll('.machine-row')].map((r) => r.textContent).join(' | ')`).catch(String))
  if (window) console.error('DOM:', (await window.webContents.executeJavaScript('document.body.innerText').catch((e) => String(e))).slice(0, 2000))
  try { console.error('daemon.log:', readFileSync(`${process.env.MU_HOME}/daemon.log`, 'utf8').slice(-2000)) } catch {}
  app.exit(1)
}
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => console.error('renderer:', event.message)))
setTimeout(() => fail('timed out'), 90_000)

await import('../out/main/main.js')
// Top-level awaits on readiness would hold up Electron's ready event, so the test runs in a function.
void (async () => {
await app.whenReady()

const until = async (js, label, ms = 15_000) => {
  for (let i = 0; i < ms / 100; i++) {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.webContents.isLoading()) {
      const value = await window.webContents.executeJavaScript(js).catch(() => undefined)
      if (value) return value
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await fail(`waiting for ${label}`)
  throw new Error('failed')
}
const run = (js, gesture = false) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js, gesture)

await until(`document.querySelector('.machine') && !document.querySelector('.machine.is-stale')`, 'local machine connected')

if (phase === 'first') {
  const id = await run(`window.mu.call('local', 'session.create', { title: '' }).then((s) => s.id)`)
  await run(`window.mu.call('local', 'session.submit', { id: '${id}', text: 'hello from smoke' })`)
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'session in sidebar')
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'answer rendered')
  // Type into the composer like a user: React needs the native setter and an input event.
  await run(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'typed message')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'typed answer rendered')
  // Settings: the app's own sections, then the machine's, drawn from what each registers.
  await run(`[...document.querySelectorAll('.app__footer button')].find((b) => b.textContent === 'Settings').click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Appearance') && document.querySelector('.settings').textContent.includes('Notifications')`, 'app settings')
  // Fonts: the picker lists installed families (needs a user gesture), and a choice sets the CSS variable.
  await run(`document.querySelector('[data-key="app.font.interface"] .mu-font-picker__button').click()`, true)
  await until(`document.querySelectorAll('.mu-font-picker__list button').length > 5`, 'installed fonts listed', 40_000)
  await run(`[...document.querySelectorAll('.mu-font-picker__list button')].find((b) => b.textContent === 'Helvetica' || b.textContent === 'Arial').click()`)
  await until(`/Helvetica|Arial/.test(document.documentElement.style.getPropertyValue('--mu-font'))`, 'interface font applied')
  await run(`window.mu.call('app', 'settings.set', { key: 'app.font.mono', value: 'Menlo' })`)
  await until(`document.documentElement.style.getPropertyValue('--mu-mono').includes('Menlo')`, 'mono font applied')
  // Machines: add one over ssh that can't connect; it shows its error, then goes away again.
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'Machines').click()`)
  await run(`window.mu.call('app', 'machines.add', { label: 'Nowhere', target: 'mu-smoke.invalid' })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('mu-smoke.invalid') && /disconnected/.test(row.textContent))`, 'ssh machine listed with its error')
  await run(`(async () => { const list = await window.mu.machines(); await window.mu.call('app', 'machines.remove', { id: list.find((m) => m.label === 'Nowhere').id }) })()`)
  await until(`![...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('mu-smoke.invalid'))`, 'machine removed')
  // A second machine: another daemon, reached through a command that pipes stdio to it (as docker exec would).
  const second = `MU_HOME='${process.env.MU_HOME}/second' MU_MODEL=faux node '${new URL('../../packages/daemon/src/cli.ts', import.meta.url).pathname}' connect --start`
  await run(`window.mu.call('app', 'machines.add', { label: 'Second', via: ${JSON.stringify(second)} })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.querySelector('input')?.value === 'Second' && / · connected/.test(row.textContent))`, 'second machine connected', 30_000)
  // All machines: a disagreement shows as Mixed, and one change reaches both.
  await run(`window.mu.call('local', 'settings.set', { key: 'agent.model', value: 'faux/faux-1' })`)
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'All machines').click()`)
  await until(`document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'mixed model across machines')
  await run(`(() => {
    const select = document.querySelector('[data-key="agent.model"] select')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'faux/faux-1')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`!document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'model set on all machines')
  const secondId = await run(`window.mu.machines().then((list) => list.find((m) => m.label === 'Second').id)`)
  const secondModel = await run(`window.mu.call('${secondId}', 'settings.watch', {}).then((r) => r.value.values['agent.model'])`)
  if (secondModel !== 'faux/faux-1') { await fail(`second machine model is ${secondModel}`); throw new Error('failed') }
  await until(`document.querySelectorAll('.app__sidebar .machine').length === 2`, 'both machines in the sidebar')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Providers') && Boolean(document.querySelector('[data-key="agent.model"]'))`, 'machine settings')
  const hasFaux = await run(`[...document.querySelectorAll('[data-key="agent.model"] option')].some((o) => o.value === 'faux/faux-1')`)
  if (!hasFaux) { await fail('model choices'); throw new Error('failed') }
  // The dialog: Escape in the font picker closes only the picker; the next Escape closes Settings.
  const escape = async () => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'General').click()`)
  await until(`Boolean(document.querySelector('[data-key="app.font.mono"]'))`, 'general pane')
  await run(`document.querySelector('[data-key="app.font.mono"] .mu-font-picker__button').click()`, true)
  await until(`document.activeElement?.placeholder === 'Search fonts'`, 'picker focused')
  await escape()
  await until(`!document.querySelector('.mu-font-picker__popover') && document.querySelector('dialog.settings')?.open === true`, 'picker closed, dialog open')
  await escape()
  await until(`!document.querySelector('dialog.settings')`, 'dialog closed by Escape')
  console.log('smoke(first): ok')
} else {
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'session after reopen')
  await until(`document.querySelectorAll('.app__sidebar .machine:not(.is-stale)').length === 2`, 'second machine reconnected after reopen', 30_000)
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'transcript after reopen')
  // App settings persisted in the app's own file.
  await until(`document.documentElement.style.getPropertyValue('--mu-mono').includes('Menlo')`, 'font after reopen')
  console.log('smoke(reopen): ok')
}
app.exit(0)
})().catch((error) => { if (error.message !== 'failed') void fail(error.stack ?? String(error)) })

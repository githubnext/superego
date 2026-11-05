// Headless end-to-end: the real app, the real daemon (scripted model), driven through the renderer.
// Phase "first" creates a session and chats; phase "reopen" is a fresh app process that must find it on the same
// daemon, which outlived the first app. Run by test/smoke.sh.
import { app, BrowserWindow } from 'electron'

const phase = process.env.MU_SMOKE_PHASE ?? 'first'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
const fail = async (message) => {
  console.error(`smoke(${phase}): FAIL ${message}`)
  const window = BrowserWindow.getAllWindows()[0]
  if (window) console.error('POPOVER:', await window.webContents.executeJavaScript(`document.querySelector('.mu-font-picker__popover')?.textContent ?? 'none'`).catch(String))
  if (window) console.error('ROWS:', await window.webContents.executeJavaScript(`[...document.querySelectorAll('.machine-row')].map((r) => r.textContent).join(' | ')`).catch(String))
  if (window) console.error('DOM:', (await window.webContents.executeJavaScript('document.body.innerText').catch((e) => String(e))).slice(0, 2000))
  try { console.error('daemon.log:', readFileSync(`${process.env.MU_HOME}/daemon.log`, 'utf8').slice(-2000)) } catch {}
  app.exit(1)
}
// Any uncaught error in the main process fails the run; in the app it would be an error dialog.
process.on('uncaughtException', (error) => void fail(`uncaught in main: ${error.stack ?? error}`))
process.on('unhandledRejection', (error) => void fail(`unhandled in main: ${error?.stack ?? error}`))
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
const STRAY = new URL('../out/main/zz-smoke-restart.js', import.meta.url).pathname
async function restartOntoNewCode(change) {
  const before = await run(`window.mu.machines().then((list) => list.find((m) => m.id === 'local'))`)
  change()
  await until(`document.querySelector('.service-notice')?.textContent.includes('Restart required')`, 'restart required shown')
  await run(`[...document.querySelectorAll('.service-notice button')].find((b) => b.textContent === 'Restart now').click()`)
  await until(`!document.querySelector('.service-notice')`, 'restart done', 40_000)
  const after = await run(`window.mu.call('local', 'hello', { client: 'smoke', version: 2 })`)
  if (after.machine.id !== before.machine.id || !(await run(`window.mu.call('local', 'session.list', {})`)).length) { await fail('restart lost the machine or its sessions'); throw new Error('failed') }
  return after
}
/** With MU_SMOKE_SHOTS=<dir>, a screenshot of the window at this point. */
const shot = async (name) => {
  if (!process.env.MU_SMOKE_SHOTS) return
  const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
  writeFileSync(`${process.env.MU_SMOKE_SHOTS}/${name}.png`, image.toPNG())
}
const run = (js, gesture = false) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js, gesture)

await until(`document.querySelector('.threads-machine') && !document.querySelector('.threads-machine.is-stale')`, 'local machine connected')

if (phase === 'first') {
  const id = await run(`window.mu.call('local', 'session.create', { title: '' }).then((s) => s.id)`)
  await run(`window.mu.call('local', 'session.submit', { id: '${id}', text: 'hello from smoke' })`)
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'session in sidebar')
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'answer rendered')
  await until(`document.querySelector('.session__profile')?.textContent === 'default'`, "the user's default profile, shown in the header")
  await shot('main')
  // Type into the composer like a user: React needs the native setter and an input event.
  await run(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'typed message')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'typed answer rendered')
  // ask-user: a replayed agent asks; the question shows above the composer and the session as needing you; an answer
  // from the card reaches it, and it carries on.
  await run(`window.mu.call('local', 'settings.set', { key: 'agent.model', value: 'replay/replay' })`)
  const asking = await run(`window.mu.call('local', 'session.create', {}).then((s) => window.mu.call('local', 'session.submit', { id: s.id, text: 'pick a colour' }).then(() => s.id))`)
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('pick a colour'))?.click()`)
  await until(`document.querySelector('.ask-user')?.textContent.includes('Which colour?')`, 'question card above the composer')
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('pick a colour') && li.querySelector('.mu-status--blocked'))`, 'session marked as needing you')
  await run(`[...document.querySelectorAll('.ask-user button')].find((b) => b.textContent === 'blue').click()`)
  await until(`!document.querySelector('.ask-user') && document.querySelector('.ask-user-asked')?.textContent.includes('blue') && document.querySelector('.transcript').textContent.includes('Blue it is.')`, 'answered, agent carried on')
  await run(`window.mu.call('local', 'settings.set', { key: 'agent.model', value: 'faux/faux-1' })`)
  void asking
  // The sidebar's modes: the ··· menu (portalled, so a scrolling sidebar can't cut it off), ⌘\\ rail, ⌘I details.
  const key = async (keyCode, modifiers = ['meta']) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  await run(`document.querySelector('.threads-menu-trigger').click()`)
  await until(`[...document.querySelectorAll('.mu-menu .mu-menu__item')].some((i) => i.textContent.includes('Needs you first'))`, 'sidebar menu open')
  await shot('menu')
  await run(`[...document.querySelectorAll('.mu-menu .mu-menu__item')].find((i) => i.textContent.includes('Needs you first')).click()`)
  await until(`[...document.querySelectorAll('.threads-group .mu-panel__title')].some((t) => t.textContent.startsWith('Done'))`, 'grouped by status')
  await key('\\')
  await until(`Boolean(document.querySelector('.threads-rail.is-compact'))`, 'rail')
  await key('\\')
  await until(`Boolean(document.querySelector('.threads-machine')) || Boolean(document.querySelector('.threads-group'))`, 'list again')
  await key('i')
  await until(`document.querySelector('.threads-details')?.textContent.includes('Machine')`, 'details pane')
  await key('i')
  await until(`!document.querySelector('.threads-details')`, 'details closed')
  await run(`window.mu.call('app', 'app.settings.set', { key: 'threads.sort', value: 'created' })`)
  // ⌘K: find a session by name and open it.
  await key('k')
  await until(`Boolean(document.querySelector('.palette__input'))`, 'palette')
  await run(`(() => {
    const input = document.querySelector('.palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'hello')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.palette__list li.is-active')?.textContent.includes('hello from smoke')`, 'palette finds the session')
  await key('Enter', [])
  await until(`!document.querySelector('.palette__input') && document.querySelector('.session__title')?.textContent === 'hello from smoke'`, 'palette opened it')
  // Every key and palette pick went through the router; the action log shows them, with where they came from.
  await key('k')
  await until(`Boolean(document.querySelector('.palette__input'))`, 'palette for the log')
  await run(`(() => {
    const input = document.querySelector('.palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'action log')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await key('Enter', [])
  await until(`[...document.querySelectorAll('.action-log__table tr')].some((tr) => tr.textContent.includes('threads.rail') && tr.textContent.includes('keys'))`, 'action log')
  await until(`[...document.querySelectorAll('.action-log__table tr')].some((tr) => tr.textContent.includes('session.select') && tr.textContent.includes('palette'))`, 'palette dispatch logged')
  await key('Escape', [])
  await until(`!document.querySelector('.action-log')`, 'log closed')
  // ⌘N: the New session dialog refuses a folder that isn't there, then starts with the prompt on ⌘⏎.
  await key('n')
  await until(`Boolean(document.querySelector('.new-session [aria-label="Prompt"]'))`, 'new session dialog')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await shot('new-session')
  const setValue = (selector, value) => run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await setValue('.new-session [aria-label="Project folder"]', '/nowhere/at/all')
  await setValue('.new-session [aria-label="Prompt"]', 'hello from the dialog')
  await run(`[...document.querySelectorAll('.new-session button')].find((b) => b.textContent.startsWith('Start')).click()`)
  await until(`document.querySelector('.new-session__error')?.textContent.includes('No folder')`, 'missing folder refused')
  await setValue('.new-session [aria-label="Project folder"]', process.env.MU_HOME)
  await key('Enter', ['meta'])
  await until(`!document.querySelector('.new-session') && document.querySelector('.transcript')?.textContent.includes('echo: hello from the dialog')`, 'started with the prompt')
  // Settings: the app's own sections, then the machine's, drawn from what each registers.
  await run(`[...document.querySelectorAll('.app__footer button')].find((b) => b.textContent === 'Settings').click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Appearance') && document.querySelector('.settings').textContent.includes('Notifications')`, 'app settings')
  await shot('settings')
  // Fonts: the picker lists installed families (needs a user gesture), and a choice sets the CSS variable.
  await run(`document.querySelector('[data-key="app.font.interface"] .mu-font-picker__button').click()`, true)
  await until(`document.querySelectorAll('.mu-font-picker__list button').length > 5`, 'installed fonts listed', 40_000)
  await run(`[...document.querySelectorAll('.mu-font-picker__list button')].find((b) => b.textContent === 'Helvetica' || b.textContent === 'Arial').click()`)
  await until(`/Helvetica|Arial/.test(document.documentElement.style.getPropertyValue('--mu-font'))`, 'interface font applied')
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.font.mono', value: 'Menlo' })`)
  await until(`document.documentElement.style.getPropertyValue('--mu-mono').includes('Menlo')`, 'mono font applied')
  // Keyboard: record a new shortcut for an action; the old one stops working, the new one runs it; a clash shows.
  const keysOf = (id) => `document.querySelector('[data-action="${id}"] .keymap__keys')`
  await until(`${keysOf('threads.rail')}?.textContent === '${process.platform === 'darwin' ? '⌘\\\\' : 'Ctrl+\\\\'}'`, 'keyboard settings list the rail shortcut')
  await run(`(() => { const b = ${keysOf('threads.rail')}; b.focus(); b.click() })()`)
  await until(`${keysOf('threads.rail')}?.classList.contains('is-recording')`, 'recording')
  await key('k', [])
  await until(`${keysOf('threads.rail')}?.textContent.includes('typing stays typing')`, 'a bare key is refused')
  await key('R', ['meta', 'shift'])
  await until(`/⇧R|Shift\\+R/.test(${keysOf('threads.rail')}?.textContent ?? '') && Boolean(document.querySelector('[data-action="threads.rail"] button.keymap__reset'))`, 'new shortcut recorded')
  await key('\\')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (await run(`Boolean(document.querySelector('.threads-rail.is-compact'))`)) { await fail('the old shortcut still runs the action'); throw new Error('failed') }
  await key('R', ['meta', 'shift'])
  await until(`Boolean(document.querySelector('.threads-rail.is-compact'))`, 'the new shortcut runs the action')
  await key('R', ['meta', 'shift'])
  await until(`!document.querySelector('.threads-rail.is-compact')`, 'and back')
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.keys', value: { 'threads.rail': 'mod+shift+r', 'threads.details': 'mod+shift+r' } })`)
  await until(`document.querySelector('[data-action="threads.rail"] .keymap__clash')?.textContent.includes('Toggle session details')`, 'clash shown')
  await run(`document.querySelector('.keymap').scrollIntoView()`)
  await shot('keyboard')
  await run(`[...document.querySelectorAll('.keymap__head button')].find((b) => b.textContent === 'Reset all').click()`)
  await until(`!document.querySelector('.keymap__clash') && ${keysOf('threads.rail')}?.textContent.includes('\\\\')`, 'reset to the actions’ own')
  // Machines: add one over ssh that can't connect; it shows its error, then goes away again.
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'Machines').click()`)
  await run(`window.mu.call('app', 'machines.add', { label: 'Nowhere', target: 'mu-smoke.invalid' })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('mu-smoke.invalid') && /disconnected/.test(row.textContent))`, 'ssh machine listed with its error')
  await run(`(async () => { const list = await window.mu.machines(); await window.mu.call('app', 'machines.remove', { id: list.find((m) => m.label === 'Nowhere').id }) })()`)
  await until(`![...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('mu-smoke.invalid'))`, 'machine removed')
  // A second machine: another daemon, reached through a command that pipes stdio to it (as docker exec would).
  const second = `MU_HOME='${process.env.MU_HOME}/second' MU_MODEL=faux node '${new URL('../bin/mu.ts', import.meta.url).pathname}' connect --start`
  await run(`window.mu.call('app', 'machines.add', { label: 'Second', via: ${JSON.stringify(second)} })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.querySelector('input')?.value === 'Second' && / · connected/.test(row.textContent))`, 'second machine connected', 30_000)
  await shot('machines')
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
  await until(`document.querySelectorAll('.threads-machine').length === 2`, 'both machines in the sidebar')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Providers') && Boolean(document.querySelector('[data-key="agent.model"]'))`, 'machine settings')
  await shot('providers')
  const hasFaux = await run(`[...document.querySelectorAll('[data-key="agent.model"] option')].some((o) => o.value === 'faux/faux-1')`)
  if (!hasFaux) { await fail('model choices'); throw new Error('failed') }
  // The menu bar: on by default; "Hide Dock icon" needs it; turning it off takes the item away.
  const desktop = () => run(`window.mu.call('app', 'app.desktop', {})`)
  if (!(await desktop()).menuBar) { await fail('menu bar item not up by default'); throw new Error('failed') }
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.hideDock', value: true })`)
  if (process.platform === 'darwin' && !(await desktop()).dockHidden) { await fail('dock not hidden'); throw new Error('failed') }
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.menuBar', value: false })`)
  await until(`window.mu.call('app', 'app.desktop', {}).then((d) => !d.menuBar && !d.dockHidden)`, 'menu bar off, dock back')
  const refused = await run(`window.mu.call('app', 'app.settings.set', { key: 'app.hideDock', value: true }).then(() => 'set', (e) => e.message)`)
  if (process.platform === 'darwin' && !/menu bar/.test(refused)) { await fail(`hide dock without menu bar: ${refused}`); throw new Error('failed') }
  await run(`window.mu.call('app', 'app.settings.set', { key: 'app.menuBar', value: true })`)
  // Restart: new daemon code on disk (faked with an extra file in the build) shows "Restart required"; restarting
  // brings up a daemon of that build, with the sessions still there.
  await restartOntoNewCode(() => writeFileSync(STRAY, '// smoke\n'))
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
  await until(`!document.querySelector('.mu-font-picker__popover') && Boolean(document.querySelector('.mu-dialog.settings'))`, 'picker closed, dialog open')
  await escape()
  await until(`!document.querySelector('.mu-dialog.settings')`, 'dialog closed by Escape')
  console.log('smoke(first): ok')
} else {
  await until(`[...document.querySelectorAll('.mu-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'session after reopen')
  await until(`document.querySelectorAll('.threads-machine:not(.is-stale)').length === 2`, 'second machine reconnected after reopen', 30_000)
  await run(`[...document.querySelectorAll('.mu-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'transcript after reopen')
  // `mu <dir> -p ...` from a terminal: a new session there, shown in this (already running) app.
  const { execFileSync } = await import('node:child_process')
  const cli = new URL('../bin/mu.ts', import.meta.url).pathname
  execFileSync('node', [cli, process.env.MU_HOME, '-p', 'from the cli'], { env: { ...process.env, MU_APP: new URL('..', import.meta.url).pathname } })
  await until(`document.querySelector('.session__title')?.textContent === 'from the cli' && document.querySelector('.transcript')?.textContent.includes('echo: from the cli')`, 'session opened from the command line', 30_000)
  // The extra file is gone again: the daemon is out of date once more, and restarts back.
  await restartOntoNewCode(() => rmSync(STRAY, { force: true }))
  // App settings persisted in the app's own file.
  await until(`document.documentElement.style.getPropertyValue('--mu-mono').includes('Menlo')`, 'font after reopen')
  console.log('smoke(reopen): ok')
}
app.exit(0)
})().catch((error) => { if (error.message !== 'failed') void fail(error.stack ?? String(error)) })

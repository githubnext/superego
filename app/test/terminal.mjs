// The terminal pane in the running app (run by `test/look.sh <dir> terminal`): opened with ⌃`, typed into, its text
// read back; light and dark; the window reloaded and the shell's output replayed; then the same terminal in a browser
// (Web access). Screenshots into $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'

const fail = (message) => { console.error(`terminal: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('renderer:', event.message) }))
setTimeout(() => fail('timed out'), 180_000)

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const win = () => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('http://127.0.0.1'))
  const untilIn = async (contents, js, label, ms = 30_000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (contents() && !contents().isLoading()) { const value = await contents().executeJavaScript(js).catch(() => undefined); if (value) return value }
      await sleep(100)
    }
    const seen = await contents()?.executeJavaScript(`JSON.stringify({ pane: document.querySelector('.terminal-pane')?.innerText, text: document.querySelector('.terminal-pane__screen')?.text?.(), hasText: typeof document.querySelector('.terminal-pane__screen')?.text })`).catch(String)
    const { readFileSync } = await import('node:fs')
    const log = (() => { try { return readFileSync(`${process.env.SUPEREGO_HOME}/daemon.log`, 'utf8').split('\n').slice(-30).join('\n') } catch (e) { return String(e) } })()
    const probe = await contents()?.executeJavaScript(`(async () => {
      const threads = await window.superego.call('local', 'thread.list', {})
      const t = threads.find((x) => x.panes?.some((p) => p.kind === 'terminal'))
      if (!t) return 'no terminal pane'
      const pane = t.panes.find((p) => p.kind === 'terminal')
      const ch = await window.superego.channel('local', 'terminal.io', { thread: t.id, pane: pane.id, cols: 80, rows: 24 })
      let n = 0; let first = ''
      ch.onData((b) => { n += b.length; if (!first) first = new TextDecoder().decode(b).slice(0, 200) })
      await new Promise((r) => setTimeout(r, 1500))
      return JSON.stringify({ n, first })
    })().catch((e) => 'probe failed: ' + e.message)`).catch(String)
    console.error('daemon.log:', log, '\nprobe:', probe)
    fail(`waiting for ${label}: ${seen}`)
    throw new Error(label)
  }
  const run = (js) => win().webContents.executeJavaScript(js)
  const until = (js, label, ms) => untilIn(() => win()?.webContents, js, label, ms)
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const shot = async (window, name) => writeFileSync(`${out}/${name}.png`, (await window.webContents.capturePage()).toPNG())
  // Keys as the terminal hears them: pressed on its screen.
  const typeIn = (contents, text) => contents.executeJavaScript(`(() => {
    const screen = document.querySelector('.terminal-pane__screen')
    for (const ch of ${JSON.stringify(text)}) {
      const key = ch === '\\n' ? 'Enter' : ch
      const code = ch === '\\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : ''
      screen.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }))
    }
  })()`)
  const text = `(document.querySelector('.terminal-pane__screen')?.text?.() ?? '')`

  await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'local machine')
  win().setContentSize(1200, 760)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Ledger' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Ledger'))`, 'the thread listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Ledger')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ledger'`, 'the thread shown')

  // ⌃`: the thread's terminal opens beside it, with the focus.
  win().webContents.sendInputEvent({ type: 'keyDown', keyCode: '`', modifiers: ['control'] })
  await until(`Boolean(document.querySelector('.terminal-pane__screen canvas'))`, 'the terminal drawn')
  await until(`${text}.length > 0`, 'a prompt')
  await until(`document.activeElement?.closest('.terminal-pane') !== null`, 'the focus in the terminal')
  await typeIn(win().webContents, `printf '\\033]7501;state=working:app=demo\\007'; git log --oneline --color=always | head -3; ls -G; echo "ok-$((6*7))"\n`)
  await until(`${text}.includes('ok-42')`, 'the command\'s output')
  await until(`Boolean(document.querySelector('.terminal-note .superego-status--working'))`, 'its status on its tab')
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await sleep(600)
    await until(`${text}.includes('ok-42')`, `the output again, ${theme}`)
    await sleep(300)
    await shot(win(), `terminal-${theme}`)
  }
  nativeTheme.themeSource = 'light'

  // A reload: the shell went on, and what it printed is replayed.
  await typeIn(win().webContents, 'echo "before-$((1+1))"\n')
  await until(`${text}.includes('before-2')`, 'output before the reload')
  win().webContents.reload()
  await until(`${text}.includes('before-2') && ${text}.includes('ok-42')`, 'the output replayed after a reload')
  await sleep(500)
  await run(`document.querySelector('.terminal-pane__screen').focus()`)
  await typeIn(win().webContents, 'echo "after-$((2+1))"\n')
  await until(`${text}.includes('after-3')`, 'typing after the reload')

  // A browser, by Web access: the same terminal, its scrollback, and typing.
  const port = 7700 + Math.floor(Math.random() * 200)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.port', value: ${port} })`)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'local' })`)
  const { link } = await until(`window.superego.call('local', 'web.pair', {}).catch(() => undefined)`, 'a pairing link')
  const browser = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: { sandbox: true, contextIsolation: true } })
  await browser.loadURL(link)
  const inBrowser = (js, label) => untilIn(() => browser.webContents, js, `web: ${label}`)
  await inBrowser(`window.superego.web === true && [...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Ledger'))`, 'the thread listed')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Ledger')).click()`)
  await inBrowser(`(${text}).includes('after-3')`, 'the terminal replayed')
  await browser.webContents.executeJavaScript(`document.querySelector('.terminal-pane__screen').focus()`)
  await typeIn(browser.webContents, 'echo "from-the-$((0+0))-browser"\n')
  await inBrowser(`(${text}).includes('from-the-0-browser')`, 'typing in the browser')
  await until(`${text}.includes('from-the-0-browser')`, 'the desktop window seeing what the browser typed')
  await sleep(300)
  await shot(browser, 'terminal-web')
  browser.destroy()
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'off' })`)

  // Closing the pane stops its shell; the thread is left as it was.
  await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').panes.find((p) => p.kind === 'terminal')).then((pane) => window.superego.call('local', 'pane.close', { thread: '${id}', pane: pane.id }))`)
  await until(`!document.querySelector('.terminal-pane')`, 'the pane closed')
  console.log('terminal: ok')
  writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
  app.exit(0)
})()

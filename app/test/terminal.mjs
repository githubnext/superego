// The terminal pane in the running app (run by `test/look.sh <dir> terminal`): opened with ⌃`, typed into, its text
// read back; light and dark; the window reloaded and the shell's output replayed; then the same terminal in a browser
// (Web access). Screenshots into $SUPEREGO_SHOWCASE_OUT.
import { BrowserWindow } from 'electron'
import { openApp } from './harness.mjs'

await openApp({ name: 'terminal', timeout: 180_000 }, async (t) => {
  const { win, run, until } = t
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

  await t.resize(1200, 760)
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
  await until(`Boolean(document.querySelector('.strip__note .superego-status--working'))`, 'its status on its tab')
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await until(`${text}.includes('ok-42')`, `the output again, ${theme}`)
    await t.shot(`terminal-${theme}`)
  }
  await t.theme('light')

  // A reload: the shell went on, and what it printed is replayed.
  await typeIn(win().webContents, 'echo "before-$((1+1))"\n')
  await until(`${text}.includes('before-2')`, 'output before the reload')
  win().webContents.reload()
  await until(`${text}.includes('before-2') && ${text}.includes('ok-42')`, 'the output replayed after a reload')
  await run(`document.querySelector('.terminal-pane__screen').focus()`)
  await typeIn(win().webContents, 'echo "after-$((2+1))"\n')
  await until(`${text}.includes('after-3')`, 'typing after the reload')

  // Settings and back: the terminal drawn again takes the keyboard only if it had it. The thread focused, it stays so.
  const focusedPane = `window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${id}').pane ?? 'thread')`
  const inTerminal = `document.activeElement?.closest('.terminal-pane') != null`
  const settingsAndBack = async (label) => {
    await run(`document.querySelector('.app__settings').click()`)
    await until(`!!document.querySelector('.settings__nav') && !document.querySelector('.terminal-pane')`, `${label}: Settings`)
    await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`)
    await until(`${text}.includes('after-3')`, `${label}: back, the terminal drawn again`)
    await t.settled()
  }
  // The focus as a shown window has it (focus events, :focus-within), headless as not: the terminal, holding it, is
  // the focused pane once that settles.
  await t.emulateFocus()
  await t.settled()
  await run(`document.activeElement?.blur(); document.querySelector('.thread__scroll').focus()`)
  await until(`${focusedPane}.then((p) => p === 'thread')`, 'the thread focused').catch(async (e) => t.fail(`${e.message}: focused ${await run(focusedPane)}, the keyboard in ${await run('document.activeElement?.className')}`))
  await settingsAndBack('the thread focused')
  if (await run(inTerminal)) t.fail('back from Settings: the terminal took the keyboard from the thread')
  if (await run(focusedPane) !== 'thread') t.fail('back from Settings: the terminal became the focused pane')
  await run(`document.querySelector('.terminal-pane__screen').focus()`)
  await until(`${focusedPane}.then((p) => p !== 'thread')`, 'the terminal focused')
  await settingsAndBack('the terminal focused')
  await until(inTerminal, 'back from Settings: the keyboard in the terminal again')

  // A browser, by Web access: the same terminal, its scrollback, and typing.
  const port = 7700 + Math.floor(Math.random() * 200)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.port', value: ${port} })`)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'local' })`)
  const { link } = await until(`window.superego.call('local', 'web.pair', {}).catch(() => undefined)`, 'a pairing link')
  const browser = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: { sandbox: true, contextIsolation: true } })
  await browser.loadURL(link)
  const b = t.on(() => browser.webContents, 'browser')
  const inBrowser = (js, label) => b.until(js, label)
  await inBrowser(`window.superego.web === true && [...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Ledger'))`, 'the thread listed')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Ledger')).click()`)
  await inBrowser(`(${text}).includes('after-3')`, 'the terminal replayed')
  await browser.webContents.executeJavaScript(`document.querySelector('.terminal-pane__screen').focus()`)
  await typeIn(browser.webContents, 'echo "from-the-$((0+0))-browser"\n')
  await inBrowser(`(${text}).includes('from-the-0-browser')`, 'typing in the browser')
  await until(`${text}.includes('from-the-0-browser')`, 'the desktop window seeing what the browser typed')
  await b.shot('terminal-web')
  browser.destroy()
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'off' })`)

  // Closing the pane stops its shell; the thread is left as it was.
  await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').panes.find((p) => p.kind === 'terminal')).then((pane) => window.superego.call('local', 'pane.close', { thread: '${id}', pane: pane.id }))`)
  await until(`!document.querySelector('.terminal-pane')`, 'the pane closed')
})

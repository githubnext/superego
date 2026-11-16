// Screenshots of MCP servers (run by `test/look.sh <dir> mcp`): Settings → MCP servers with a server in each state
// (running, needing a key, needing sign-in, signed in, switched off, waiting for Allow), an OAuth client's secret, the Add dialog filled from the catalogue,
// and a thread that called a server's tools: its rows (one open, with its arguments, result and image), its chip's list
// and thread details. Light and dark, into $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'

const fail = (message) => { console.error(`look: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('renderer:', event.message) }))
setTimeout(() => fail('timed out'), 180_000)

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const win = () => BrowserWindow.getAllWindows()[0]
  const run = (js) => win().webContents.executeJavaScript(js)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (js, label, ms = 30_000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (win() && !win().webContents.isLoading()) { const value = await run(js).catch(() => undefined); if (value) return value }
      await sleep(100)
    }
    fail(`waiting for ${label}`)
    throw new Error(label)
  }
  const both = async (name, before = '') => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      if (before) await run(before)
      await sleep(150)
      writeFileSync(`${out}/${name}-${theme}.png`, (await win().webContents.capturePage()).toPNG())
    }
  }
  const click = (selector, text) => run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.includes(${JSON.stringify(text)}))?.click()`)
  const escape = () => run(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'local machine')
  win().setContentSize(1100, 760)

  // A thread without a profile: it has the servers used in threads without one (the tracker, as "linear").
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'File the CSV bug' })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: 'File the quoted-comma CSV bug in Linear, and show me how the team is doing.' })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => ['done', 'error'].includes(list.find((t) => t.id === '${id}')?.status.state))`, 'the answer', 60_000)
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('File the CSV bug'))?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  // Its run of work open, and the call that filed the issue and the chart open in it.
  await run(`document.querySelectorAll('.transcript details:not([open])').forEach((d) => { if (!d.closest('.step') || d.classList.contains('steps') || d.querySelector(':scope > summary')?.textContent.match(/Called|Create|Chart|MCP/)) d.open = true })`)
  await sleep(200)
  await run(`document.querySelectorAll('.step').forEach((d) => { if (/Create issue|Chart/.test(d.textContent)) d.open = true })`)
  await until(`!!document.querySelector('.mcp-call')`, 'an MCP row open')
  await both('mcp-transcript', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
  await both('mcp-transcript-top', `document.querySelector('.mcp-call__subject')?.scrollIntoView({ block: 'start' })`)

  // The chip in the header, open.
  await until(`!!document.querySelector('.mcp-chip')`, 'the MCP chip')
  await run(`document.querySelector('.mcp-chip').click()`)
  await until(`!!document.querySelector('.mcp-chip__popup')`, 'the chip open')
  await both('mcp-chip')
  await escape()
  await until(`!document.querySelector('.mcp-chip__popup')`, 'the chip closed')

  // Thread details (⌘I), with the thread's servers.
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))`)
  await until(`!!document.querySelector('.threads-details .mcp-list')`, 'details with servers')
  await both('mcp-details')
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true }))`)

  // Settings → MCP servers.
  await run(`document.querySelector('.app__settings').click()`)
  await until(`Boolean(document.querySelector('.settings__nav'))`, 'Settings')
  await click('.settings__nav button', 'This computer')
  await until(`document.querySelectorAll('.mcp-server').length >= 6`, 'the servers')
  await both('mcp-settings', `document.querySelector('.mcp-servers')?.closest('.settings-section')?.scrollIntoView({ block: 'start' })`)
  await both('mcp-settings-end', `document.querySelector('.mcp-servers__add')?.scrollIntoView({ block: 'end' })`)
  // Set key, open under its row.
  await run(`[...document.querySelectorAll('.mcp-server')].find((r) => r.textContent.includes('github'))?.querySelector('.provider__actions button')?.click()`)
  await until(`!!document.querySelector('.mcp-secrets')`, 'the key field')
  await both('mcp-set-key', `document.querySelector('.mcp-secrets')?.scrollIntoView({ block: 'center' })`)
  // A signed-in OAuth server's client secret, optional, from its menu.
  await run(`[...document.querySelectorAll('.mcp-server')].find((r) => r.textContent.includes('atlassian'))?.querySelector('.mcp-server__more')?.click()`)
  await until(`[...document.querySelectorAll('[role=menuitem]')].some((i) => i.textContent === 'Client secret…')`, 'the menu')
  await click('[role=menuitem]', 'Client secret…')
  await until(`!!document.querySelector('.mcp-secrets input[placeholder="Optional"]')`, 'the client secret field')
  await both('mcp-client-secret', `document.querySelector('.mcp-secrets')?.scrollIntoView({ block: 'center' })`)

  // Add server, filled from the catalogue.
  await click('.mcp-servers__add button', 'Add server')
  await until(`!!document.querySelector('.mcp-dialog')`, 'the Add dialog')
  await run(`(() => { const select = document.querySelector('.mcp-dialog select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    set.call(select, 'sentry'); select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await until(`[...document.querySelectorAll('.mcp-dialog input')].some((i) => i.value === 'SENTRY_ACCESS_TOKEN')`, 'Sentry filled in')
  await both('mcp-add')
  await escape()

  nativeTheme.themeSource = 'system'
  writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
  app.exit(0)
})()

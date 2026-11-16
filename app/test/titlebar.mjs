// Screenshots of the title bar (run by `test/look.sh <dir> titlebar`): a thread with a profile of the user's, its title bar
// in light and dark, then the profile's card, opened by pointing at it, and the sidebar's heading pointed at. Into $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { threads } from './showcase/threads.mjs'

const fail = (message) => { console.error(`titlebar: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('renderer:', event.message) }))
setTimeout(() => fail('timed out'), 180_000)

// A profile of the user's, bringing an extension of its own and one of the machine's MCP servers.
const profile = join(process.env.SUPEREGO_HOME, 'profiles', 'reviewer')
mkdirSync(profile, { recursive: true })
writeFileSync(join(profile, 'profile.ts'), `export default {
  description: 'Reviews a change for bugs and missing tests',
  extensions: ['./notes.ts'],
  mcp: ['github'],
}\n`)
writeFileSync(join(profile, 'notes.ts'), `export default { name: 'notes' }\n`)

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
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
  await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'local machine')
  win().setContentSize(1100, 600)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, profile: 'reviewer', title: 'Review the ledger import' })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(threads[0].prompt)} })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => ['done', 'error'].includes(list.find((s) => s.id === '${id}')?.status.state))`, 'answer')
  await run(`window.superego.call('local', 'thread.seen', { thread: '${id}' })`)
  await until(`([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Review the ledger'))?.click(), !!document.querySelector('.thread__profile'))`, 'thread shown')
  await sleep(500)
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const bar = await run(`(() => { const r = document.querySelector('.app__titlebar').getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.right), height: Math.ceil(r.bottom) } })()`)
  const shot = async (name, rect) => writeFileSync(`${out}/${name}.png`, (await win().webContents.capturePage(rect)).toPNG())
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await sleep(400)
    await shot(`titlebar-${theme}`, bar)
    await shot(`window-${theme}`)
  }
  // Pointed at, the profile says what it is.
  const chip = await run(`(() => { const r = document.querySelector('.thread__profile').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await sleep(300)
    win().webContents.sendInputEvent({ type: 'mouseMove', x: chip.x - 40, y: chip.y + 200 })
    await sleep(300)
    win().webContents.sendInputEvent({ type: 'mouseMove', x: chip.x, y: chip.y })
    await sleep(1200)
    const card = await run(`(() => { const c = document.querySelector('.profile-card'); if (!c) return undefined; const r = c.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left) - 24), y: 0, width: Math.ceil(r.width) + 48, height: Math.ceil(r.bottom) + 24 } })()`)
    console.log('profile card:', card ? JSON.stringify(card) : 'none')
    await shot(`profile-card-${theme}`, card ?? bar)
    await shot(`window-profile-card-${theme}`)
  }
  // Pointed at, the sidebar's heading shows the key that goes anywhere.
  const head = await run(`(() => { const r = document.querySelector('.threads__head').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2), rect: { x: Math.floor(r.left) - 8, y: Math.floor(r.top) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 } } })()`)
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await sleep(300)
    win().webContents.sendInputEvent({ type: 'mouseMove', x: head.x, y: head.y + 300 })
    await sleep(300)
    win().webContents.sendInputEvent({ type: 'mouseMove', x: head.x, y: head.y })
    await sleep(500)
    await shot(`threads-head-${theme}`, head.rect)
  }
  writeFileSync(join(process.env.SUPEREGO_HOME, 'passed'), '')
  app.exit(0)
})().catch((error) => fail(error.stack ?? String(error)))

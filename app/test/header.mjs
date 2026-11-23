// The README's header and the site's link preview (run by `test/look.sh <dir> header`; site/shots.sh makes the images
// from it): threads in three projects in the sidebar (at work, waiting on you, done), the one shown
// building Ledger's home page (a task's steps, a word and a code block, and at work on a follow-up) with the page in a
// Browser pane beside it, and the thread holding the focus. The window at
// 1440×760 (a link preview's shape), light and dark, into $SUPEREGO_SHOWCASE_OUT as header-light.png and header-dark.png. The turns are scripted (test/showcase/header.mjs); everything else is the app's own.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { webContents } from 'electron'
import { openApp } from './harness.mjs'
import { PORT, THREADS } from './showcase/header.mjs'

const ledger = process.env.SUPEREGO_SHOWCASE_PROJECT
const projectOf = (name) => name === 'ledger' ? ledger : join(dirname(ledger), name)
// The shown thread's site, as it writes it.
const server = createServer((q, r) => {
  try {
    const path = q.url === '/' ? 'index.html' : q.url.slice(1)
    r.setHeader('content-type', path.endsWith('.css') ? 'text/css' : 'text/html')
    r.end(readFileSync(join(ledger, 'site', path)))
  } catch {
    // A page the site hasn't got (yet): a 404 is what a browser would see.
    r.statusCode = 404
    r.end()
  }
})
await new Promise((resolve, reject) => server.once('error', reject).listen(PORT, '127.0.0.1', resolve))
  .catch((error) => { console.error(`header: port ${PORT} is taken (${error.message})`); process.exit(1) })

await openApp({ name: 'header', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1440, 760)
  const list = () => t.call('thread.list', {})
  const byTitle = async (title) => (await list()).find((thread) => thread.title === title)

  // Each project a git repo of its own; each thread started there and sent its first message.
  for (const name of new Set(THREADS.map((thread) => thread.project))) {
    if (name === 'ledger') continue
    mkdirSync(projectOf(name), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: projectOf(name) })
  }
  // One at a time, each where the scene wants it, so the sidebar's order is the list's.
  for (const { project, title, prompt, state } of THREADS) {
    const { id } = await t.call('thread.start', { cwd: projectOf(project), title })
    await t.call('thread.send', { thread: id, text: prompt })
    await until(async () => (await byTitle(title))?.status.state === state, `${title} ${state}`, 60_000)
  }
  for (const thread of await list()) if (thread.status.state === 'error') t.fail(`${thread.title} failed: ${thread.status.msg}`)
  // Read, but for the ones the scene leaves unread.
  for (const { title, state, unread } of THREADS) if (state !== 'blocked' && !unread) await t.call('thread.seen', { thread: (await byTitle(title)).id })

  const shown = THREADS.find((thread) => thread.shown)
  const { id } = await byTitle(shown.title)
  await t.call('thread.send', { thread: id, text: shown.followUp.text })
  await until(async () => (await byTitle(shown.title))?.status.state === shown.followUp.state, `${shown.title} ${shown.followUp.state} again`, 60_000)
  const row = `[...document.querySelectorAll('.app__sidebar .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(shown.title)})`
  await until(`Boolean(${row})`, 'the thread listed')
  await run(`${row}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(shown.title)}`, 'the thread shown')
  await until(`!!document.querySelector('.transcript pre') && [...document.querySelectorAll('.transcript details.task')].some((d) => d.textContent.includes('Turning the README'))`, 'the answer and the follow-up\'s task in')
  const url = `http://localhost:${PORT}/`
  const view = await until(() => webContents.getAllWebContents().find((w) => w.getURL() === url && !w.isLoading()), "the page's view")
  const placed = () => t.win().contentView.children.find((v) => v.webContents === view)
  await until(() => placed()?.getVisible(), 'the page shown beside the thread')

  await t.emulateFocus()
  await t.lights()
  const focus = `(() => { const el = document.querySelector('.thread__scroll'); el.scrollTop = el.scrollHeight; el.focus({ preventScroll: true, focusVisible: true }); return document.activeElement === el })()`
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await until(focus, 'the thread focused')
    await t.settled()
    // The page is a view of its own over the window, not in its screenshot: drawn in at its bounds, its corners
    // rounded as its box's (as keptpage.mjs does).
    const debug = view.debugger
    debug.attach()
    const { data } = await debug.sendCommand('Page.captureScreenshot', { format: 'png' })
    debug.detach()
    const zoom = t.contents().getZoomFactor(), b = placed().getBounds()
    const radius = await run(`parseFloat(getComputedStyle(document.querySelector('.browser-frame .web-view')).borderTopLeftRadius) || 0`)
    const over = { data, x: b.x / zoom, y: b.y / zoom, width: b.width / zoom, height: b.height / zoom, radius }
    await run(`(() => { const v = ${JSON.stringify(over)}; const img = document.createElement('img'); img.className = 'look-native-view'; img.src = 'data:image/png;base64,' + v.data
      Object.assign(img.style, { position: 'fixed', left: v.x + 'px', top: v.y + 'px', width: v.width + 'px', height: v.height + 'px', borderRadius: v.radius + 'px', zIndex: 98, pointerEvents: 'none' }); document.body.append(img) })()`)
    await until(`[...document.querySelectorAll('.look-native-view')].every((img) => img.complete)`, 'the view drawn')
    await t.shot(`header-${theme}`)
    await run(`document.querySelectorAll('.look-native-view').forEach((img) => img.remove())`)
  }
  server.close()
})

// Preview as a browser tab: a page of its own over its pane. A sign-in that sets a SameSite=Lax cookie on one port and
// redirects to another holds, and still does after a reload; the header follows the page's address and goes back; a page
// that refuses frames loads; a link to a new window goes to the browser. The view follows its pane: hidden (a still in its
// place) under a dialog, hidden at the back of a stack, given the keyboard as its pane is focused.
import { createServer } from 'node:http'
import { shell } from 'electron'
import { clickInto, home, openRow, pageAt } from './common.mjs'

const listen = (handler) => new Promise((resolve) => { const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(server)) })

export default async function preview(t) {
  // The app (as a dev server is): signed in by its session cookie, which only the sign-in server sets.
  const app = await listen((req, res) => {
    const signedIn = /(^|;\s*)session=mikker/.test(req.headers.cookie ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    if (req.url === '/popup') return res.end('<a id="out" href="https://example.com/elsewhere" target="_blank">out</a>')
    res.end(signedIn ? `<title>signed in as mikker</title><a id="next" href="/next">next</a>` : '<title>visit /as/&lt;login&gt; first</title>')
  })
  const appUrl = `http://127.0.0.1:${app.address().port}`
  // The sign-in, at another port: sets the cookie and sends the browser back to the app.
  const signIn = await listen((req, res) => {
    res.writeHead(302, { location: `${appUrl}/`, 'set-cookie': 'session=mikker; Path=/; SameSite=Lax; HttpOnly' })
    res.end()
  })
  const signInUrl = `http://127.0.0.1:${signIn.address().port}/as/mikker`
  // A page that refuses to be framed, anywhere.
  const refusing = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" })
    res.end('<title>no frames</title>')
  })
  const refusingUrl = `http://127.0.0.1:${refusing.address().port}/`

  // The thread shown before, shown again after: the next area takes up where the last left off.
  const before = await t.run(`document.querySelector('.thread__title')?.textContent`)
  const thread = (await t.call('thread.start', { cwd: home, title: 'signing in' })).id
  await t.until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('signing in'))`, 'the thread listed')
  await t.run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('signing in')).click()`)
  await t.until(`document.querySelector('.thread__title')?.textContent === 'signing in'`, 'the thread open')
  await t.call('pane.open', { thread, kind: 'preview', params: { url: signInUrl } })
  const page = () => pageAt(appUrl)
  const title = async () => page()?.isLoading() === false && page().getTitle()
  await t.until(async () => await title() === 'signed in as mikker', 'signed in, through the redirect, by the cookie')
  // Its address in the header is the page's, now the app's; and it's shown over its pane.
  await t.until(`document.querySelector('.panes__column:has(.web-view) .pane-header__url')?.textContent.startsWith(${JSON.stringify(`${appUrl}/`)})`, "the header shows the page's address")
  // Shown over its pane, once it's whole in view (given the focus, it's scrolled to): not put out of sight, as it is
  // while something's over it or it's cut short.
  const viewShown = () => t.win().contentView.children.some((v) => v.webContents === page() && v.getVisible() && v.getBounds().x >= 0 && v.getBounds().y >= 0)
  const previewPane = () => t.call('thread.list').then((list) => list.find((x) => x.id === thread).panes.find((p) => p.kind === 'preview').id)
  await t.call('pane.focus', { thread, pane: await previewPane() })
  await t.until(viewShown, 'the page shown over its pane')
  const box = await t.run(`(() => { const r = document.querySelector('.web-view').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round) })()`)
  const bounds = t.win().contentView.children.find((v) => v.webContents === page()).getBounds()
  const zoom = t.contents().getZoomFactor()
  if ([bounds.x, bounds.y, bounds.width, bounds.height].some((v, i) => Math.abs(v - box[i] * zoom) > 2)) t.fail(`the view at ${JSON.stringify(bounds)}, its pane at ${box}`)

  // Reloaded, it's still signed in: the cookie is the page's own.
  await t.click('.panes__column:has(.web-view) .pane-header__button', 'Reload')
  await t.until(async () => page()?.isLoading() === false && await title() === 'signed in as mikker', 'still signed in after a reload')
  // Its own links, then back: the header follows.
  await page().executeJavaScript(`document.getElementById('next').click()`, true)
  await t.until(`document.querySelector('.panes__column:has(.web-view) .pane-header__url')?.textContent === ${JSON.stringify(`${appUrl}/next`)}`, 'the header follows a link')
  await t.until(`!document.querySelector('.panes__column:has(.web-view) button[aria-label="Back"]').disabled`, 'back offered')
  await t.click('.panes__column:has(.web-view) button[aria-label="Back"]')
  await t.until(`document.querySelector('.panes__column:has(.web-view) .pane-header__url')?.textContent === ${JSON.stringify(`${appUrl}/`)}`, 'back again')

  // Under a dialog, the page is hidden, a still of it in its place; back once it's gone.
  t.key('n')
  await t.until(`Boolean(document.querySelector('.superego-dialog'))`, 'a dialog over the pane')
  await t.until(() => !viewShown(), 'the page hidden under the dialog')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.superego-dialog')`, 'the dialog gone')
  await t.until(viewShown, 'the page shown again')

  // A click into the page focuses its pane, and brings it forward.
  clickInto(t, page())
  await t.until(`document.activeElement?.matches('.web-view')`, 'a click into the page focuses its pane')
  await t.until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('Preview')`, 'and brings it forward')

  // A link to a new window opens in the browser.
  const opened = []
  const openExternal = shell.openExternal
  shell.openExternal = async (url) => { opened.push(url) }
  await page().loadURL(`${appUrl}/popup`)
  await page().executeJavaScript(`document.getElementById('out').click()`, true)
  await t.until(() => opened.includes('https://example.com/elsewhere'), 'a new window opened in the browser')
  shell.openExternal = openExternal

  // Behind another pane in a stack, the page isn't shown at all.
  await t.call('pane.open', { thread, kind: 'editor', params: { path: 'notes.md' } })
  await t.click('.strip__layout [aria-label="Stack panes"]')
  await t.until(`Boolean(document.querySelector('.panes--stack'))`, 'stacked')
  await t.until(() => !viewShown(), 'hidden behind the editor')
  await t.click('.strip__layout [aria-label="Scroll panes"]')
  await t.until(`!document.querySelector('.panes--stack')`, 'scrolled again')
  await t.call('pane.close', { thread, pane: (await t.call('thread.list')).find((x) => x.id === thread).panes.find((p) => p.kind === 'editor').id })

  // A page that refuses frames loads: it isn't framed.
  await t.call('pane.update', { thread, pane: await previewPane(), params: { url: refusingUrl } })
  await t.until(async () => pageAt(refusingUrl)?.isLoading() === false && pageAt(refusingUrl).getTitle() === 'no frames', 'a page that refuses frames, loaded')
  // The window's shortcuts work from inside the page: ⌘W closes its pane, and the page with it.
  const key = (keyCode) => { for (const type of ['keyDown', 'keyUp']) pageAt(refusingUrl).sendInputEvent({ type, keyCode, modifiers: ['meta'] }) }
  key('w')
  await t.until(`!document.querySelector('.web-view')`, 'cmd+w from inside the page closed its pane')
  await t.until(() => !pageAt(refusingUrl), 'its page closed with its pane')
  for (const server of [app, signIn, refusing]) server.close()
  if (before) {
    await openRow(t, before)
    await t.until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(before)}`, `back to ${before}`)
  }
}

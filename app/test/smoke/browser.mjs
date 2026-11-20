// Browser as a browser tab: a page of its own over its pane. A sign-in that sets a SameSite=Lax cookie on one port and
// redirects to another holds, and still does after a reload; the header follows the page's address and goes back; ⌘L in
// the page is the navigator; the address bar, clicked, takes a bare host typed there, an HTML file's path shows the file
// (with its own cookies), and the web page again is still signed in; a page that refuses frames loads; a link to a new
// window goes to the browser. The view follows its pane: hidden (a still in its place) under a dialog, hidden at the back of a stack, a still under the thread kept in view as the panes scroll under it. It's kept for its pane: drawn again, it's as it was.
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { session, shell, webContents } from 'electron'
import { clickInto, home, openRow, pageAt } from './common.mjs'

const listen = (handler) => new Promise((resolve) => { const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(server)) })

export default async function browser(t) {
  // The app (as a dev server is): signed in by its session cookie, which only the sign-in server sets.
  const held = []
  const app = await listen((req, res) => {
    const signedIn = /(^|;\s*)session=mikker/.test(req.headers.cookie ?? '')
    res.writeHead(200, { 'content-type': 'text/html' })
    if (req.url === '/popup') return res.end('<a id="out" href="https://example.com/elsewhere" target="_blank">out</a>')
    // Never answered until it's let go (`slow`): a page that takes its time.
    if (req.url === '/slow') return held.push(res)
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
  await t.call('pane.open', { thread, kind: 'browser', params: { url: signInUrl } })
  const page = () => pageAt(appUrl)
  const title = async () => page()?.isLoading() === false && page().getTitle()
  await t.until(async () => await title() === 'signed in as mikker', 'signed in, through the redirect, by the cookie')
  // Its address in the header is the page's, now the app's; and it's shown over its pane.
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent.startsWith(${JSON.stringify(`${appUrl}/`)})`, "the header shows the page's address")
  // Shown over its pane, once it's whole in view (given the focus, it's scrolled to): not put out of sight, as it is
  // while something's over it or it's cut short.
  const viewShown = () => t.win().contentView.children.some((v) => v.webContents === page() && v.getVisible() && v.getBounds().x >= 0 && v.getBounds().y >= 0)
  const browserPane = () => t.call('thread.list').then((list) => list.find((x) => x.id === thread).panes.find((p) => p.kind === 'browser').id)
  await t.call('pane.focus', { thread, pane: await browserPane() })
  await t.until(viewShown, 'the page shown over its pane')
  const box = await t.run(`(() => { const r = document.querySelector('.web-view').getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round) })()`)
  const bounds = t.win().contentView.children.find((v) => v.webContents === page()).getBounds()
  const zoom = t.contents().getZoomFactor()
  if ([bounds.x, bounds.y, bounds.width, bounds.height].some((v, i) => Math.abs(v - box[i] * zoom) > 2)) t.fail(`the view at ${JSON.stringify(bounds)}, its pane at ${box}`)

  // Reloaded, it's still signed in: the cookie is the page's own.
  await t.click('.panes__column:has(.web-view) button[aria-label="Reload"]')
  await t.until(async () => page()?.isLoading() === false && await title() === 'signed in as mikker', 'still signed in after a reload')
  // Its own links, then back: the header follows.
  await page().executeJavaScript(`document.getElementById('next').click()`, true)
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent === ${JSON.stringify(`${appUrl}/next`)}`, 'the header follows a link')
  await t.until(`!document.querySelector('.panes__column:has(.web-view) button[aria-label="Back"]').disabled`, 'back offered')
  await t.click('.panes__column:has(.web-view) button[aria-label="Back"]')
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent === ${JSON.stringify(`${appUrl}/`)}`, 'back again')

  // At a size: picked from the toolbar, the page laid out that wide (its media queries see it), kept in the pane's params;
  // wider than the pane, drawn smaller to fit, still that wide; a reload keeps it; Full is the pane's width again.
  const sizeOf = async () => (await t.call('thread.list')).find((x) => x.id === thread).panes.find((p) => p.kind === 'browser').params?.viewport
  const innerWidth = () => page()?.executeJavaScript('innerWidth')
  const pickSize = async (label) => {
    await t.click('.panes__column:has(.web-view) button[aria-label="Page size"]')
    await t.until(`[...document.querySelectorAll('[role^="menuitem"]')].some((el) => el.textContent.startsWith(${JSON.stringify(label)}))`, `the size menu, with ${label}`)
    await t.run(`[...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent.startsWith(${JSON.stringify(label)})).click()`)
  }
  await pickSize('Small')
  await t.until(async () => (await sizeOf())?.width === 390, 'Small kept in the pane')
  await t.until(async () => await innerWidth() === 390, 'the page 390 wide')
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-page')?.offsetWidth === 390`, 'its frame 390 wide')
  await pickSize('Large')
  await t.until(async () => (await sizeOf())?.width === 1280, 'Large kept in the pane')
  await t.until(async () => await innerWidth() === 1280, 'the page 1280 wide, scaled to fit')
  const scaled = await t.run(`document.querySelector('.panes__column:has(.web-view) .web-view').getBoundingClientRect().width`)
  if (scaled >= 1280) t.fail(`the page not scaled to fit its pane (${scaled} wide)`)
  await t.until(`/\\d+%/.test(document.querySelector('.panes__column:has(.web-view) .browser-size__scale')?.textContent ?? '')`, 'its scale shown')
  await t.until(() => Math.abs(t.win().contentView.children.find((v) => v.webContents === page()).getBounds().width - scaled * t.contents().getZoomFactor()) <= 2, 'the view as wide as its scaled frame')
  await t.click('.panes__column:has(.web-view) button[aria-label="Reload"]')
  await t.until(async () => page()?.isLoading() === false && await title() === 'signed in as mikker' && await innerWidth() === 1280, 'still 1280 wide after a reload')
  await pickSize('Full')
  await t.until(async () => await sizeOf() === undefined, 'Full: no size kept')
  const paneWidth = await t.run(`document.querySelector('.panes__column:has(.web-view) .browser-stage').clientWidth`)
  await t.until(async () => Math.abs(await innerWidth() - paneWidth * t.contents().getZoomFactor()) <= 1, "the page the pane's width again")

  // A page that takes its time: a line along the toolbar's foot, a spinner on its tab and in the address, and Stop; stopped,
  // it's all gone, and the page is where it was.
  await page().executeJavaScript(`location.href = '/slow'`, true)
  const loading = `Boolean(document.querySelector('.panes__column:has(.web-view) .browser-load:not(.is-done)')) && Boolean(document.querySelector('.panes__column:has(.web-view) .browser-address .browser-spinner')) && [...document.querySelectorAll('.strip__tab')].some((tab) => tab.querySelector('.browser-spinner'))`
  await t.until(loading, 'the page shown loading')
  await t.click('.panes__column:has(.web-view) button[aria-label="Stop"]')
  await t.until(`!document.querySelector('.panes__column:has(.web-view) .browser-load') && !document.querySelector('.browser-spinner') && Boolean(document.querySelector('.panes__column:has(.web-view) button[aria-label="Reload"]'))`, 'stopped: the line, spinners and Stop gone')
  if (!page() || page().isLoading()) t.fail('the page still loading after Stop')
  for (const res of held.splice(0)) res.destroy()
  // A page that doesn't load says why, in the pane.
  const gone = await listen(() => {})
  const goneUrl = `http://127.0.0.1:${gone.address().port}/`
  await new Promise((resolve) => gone.close(resolve))
  await page().executeJavaScript(`location.href = ${JSON.stringify(goneUrl)}`, true)
  await t.until(`document.querySelector('.panes__column:has(.web-view) .web-view__error')?.textContent.includes('ERR_CONNECTION_REFUSED') && !document.querySelector('.panes__column:has(.web-view) .browser-load:not(.is-done)')`, "the page that didn't load says why")
  await t.click('.panes__column:has(.web-view) button[aria-label="Back"]')
  await t.until(`!document.querySelector('.web-view__error') && document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent === ${JSON.stringify(`${appUrl}/`)}`, 'back from the page that failed')

  // ⌘L from inside the page is the window's navigator, as anywhere.
  for (const type of ['keyDown', 'keyUp']) page().sendInputEvent({ type, keyCode: 'l', modifiers: ['meta'] })
  await t.until(`Boolean(document.querySelector('.navigator'))`, 'cmd+L in the page opens the navigator')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.navigator')`, 'the navigator closed')
  // The address bar, clicked: a field, the address selected to type over.
  const field = 'input.browser-address'
  await t.click('.panes__column:has(.web-view) button.browser-address')
  await t.until(`document.activeElement?.matches(${JSON.stringify(field)}) && document.activeElement.selectionEnd === document.activeElement.value.length && document.activeElement.selectionStart === 0`, 'the address bar a field, its address selected')
  // A bare host goes there, over http as it's this computer's, and the pane points there.
  const paneParams = async () => (await t.call('thread.list')).find((x) => x.id === thread).panes.find((p) => p.kind === 'browser').params
  await t.type(field, `127.0.0.1:${app.address().port}/next`, { enter: true })
  await t.until(async () => (await paneParams())?.url === `${appUrl}/next`, 'the pane pointed at the address typed')
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent === ${JSON.stringify(`${appUrl}/next`)}`, 'the page at the address typed')
  await t.until(async () => page()?.isLoading() === false && await title() === 'signed in as mikker', 'still signed in there')
  // An HTML file in the working folder, by its path: shown from its own origin, with cookies of its own.
  writeFileSync(join(home, 'typed.html'), '<title>typed</title>')
  const typed = () => webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith('superego-artifact:') && c.getURL().endsWith('/typed.html'))
  await t.click('.panes__column:has(.web-view) button.browser-address')
  await t.until(`document.activeElement?.matches(${JSON.stringify(field)})`, 'the address bar, clicked')
  await t.type(field, 'typed.html', { enter: true })
  await t.until(async () => (await paneParams())?.path === 'typed.html', 'the pane pointed at the file')
  await t.until(() => typed()?.isLoading() === false && typed().getTitle() === 'typed', 'the file shown')
  if (typed().session !== session.fromPartition('superego-artifact')) t.fail("the file shown in the web's session")
  await t.until(`document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent === 'typed.html' && [...document.querySelectorAll('.panes__tab')].some((tab) => tab.textContent.includes('typed.html'))`, 'its address and tab its path')
  // And back to the web: a page of the web's session again, still signed in.
  await t.click('.panes__column:has(.web-view) button.browser-address')
  await t.type(field, `${appUrl}/`, { enter: true })
  await t.until(async () => page()?.isLoading() === false && await title() === 'signed in as mikker', 'back on the web, still signed in')
  await t.until(() => !typed(), "the file's page closed")
  if (page().session !== session.fromPartition('persist:browser')) t.fail("the web page not in the web's session")

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
  await t.until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('Browser')`, 'and brings it forward')

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

  // The panes scrolled under the thread kept in view: the page cut short by it is a still in its place, which the thread
  // covers (the view itself would draw over the thread); wholly under it, not placed at all; scrolled back, shown.
  await t.call('pane.open', { thread, kind: 'editor', params: { path: 'more.md' } })
  await t.until(`Boolean(document.querySelector('.panes--keep'))`, 'the thread kept in view')
  // The last pane focused, and the row come to rest there: scrolled by hand from there on.
  await t.call('pane.focus', { thread, pane: (await t.call('thread.list')).find((x) => x.id === thread).panes.at(-1).id })
  const scrollLeft = () => t.run(`document.querySelector('.panes').scrollLeft`)
  await t.until(async () => { const was = await scrollLeft(); await t.settled(); await t.settled(); return was === await scrollLeft() && await t.run(`document.querySelector('.panes__column.is-last').getBoundingClientRect().right <= document.querySelector('.panes').getBoundingClientRect().right + 1`) }, 'the row at rest at the last pane')
  const placedView = () => t.win().contentView.children.find((v) => v.webContents === page())
  const scrollUnder = (by) => t.run(`(() => {
    const row = document.querySelector('.panes'), edge = document.querySelector('.panes__gap--thread').getBoundingClientRect().right
    const page = document.querySelector('.web-view').getBoundingClientRect()
    row.scrollLeft += page.left - edge + ${by === 'all' ? 'page.width + 8' : by}
    return document.querySelector('.web-view').getBoundingClientRect().left - edge
  })()`)
  const partly = await scrollUnder(120)
  if (partly > -100) t.fail(`the page not scrolled under the thread (its left ${partly}px from the thread's edge)`)
  await t.until(() => !viewShown(), 'the page cut short by the thread: the view out of sight')
  await t.until(`Boolean(document.querySelector('.web-view__still'))`, 'a still in its place')
  const covering = await t.run(`(() => { const r = document.querySelector('.web-view').getBoundingClientRect(), at = document.elementFromPoint(r.left + 40, r.top + r.height / 2); return at?.closest('.panes__column--thread, .panes__gap--thread') ? '' : \`\${at?.outerHTML.slice(0, 120)} at \${r.left + 40}\` })()`)
  if (covering) t.fail(`the still not under the thread: ${covering}`)
  await scrollUnder('all')
  await t.until(`document.querySelector('.web-view').getBoundingClientRect().right <= document.querySelector('.panes__gap--thread').getBoundingClientRect().right`, 'the page wholly under the thread')
  await t.until(() => !placedView()?.getVisible(), 'wholly under the thread: not placed')
  await t.call('pane.focus', { thread, pane: await browserPane() })
  await t.until(viewShown, 'scrolled back beside the thread: shown')
  const back = placedView().getBounds()
  const edge = await t.run(`document.querySelector('.panes__gap--thread').getBoundingClientRect().right`)
  if (back.x < edge * t.contents().getZoomFactor() - 1) t.fail(`the view at ${back.x}, over the thread's edge at ${edge}`)
  for (const pane of (await t.call('thread.list')).find((x) => x.id === thread).panes.filter((p) => p.kind === 'editor')) await t.call('pane.close', { thread, pane: pane.id })

  // The page is the pane's, not its drawing's: drawn again (the window resized, the sidebar hidden and shown, Settings
  // opened and closed, another thread shown and this one again), it's as it was, where the user took it, never loaded
  // again.
  let counted = 0
  const counting = await listen((req, res) => {
    if (req.url === '/') counted++
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>counted</title><a id="on" href="/on">on</a>')
  })
  const countingUrl = `http://127.0.0.1:${counting.address().port}/`
  await t.call('pane.update', { thread, pane: await browserPane(), params: { url: countingUrl } })
  await t.until(async () => pageAt(countingUrl)?.isLoading() === false && pageAt(countingUrl).getTitle() === 'counted', 'a page that counts its loads')
  const counter = pageAt(countingUrl)
  // Placed over its pane: live, or (the pane cut short, as the row's scroll isn't kept as it's drawn again) a still of it.
  const counterPlaced = () => t.win().contentView.children.some((v) => v.webContents === counter && v.getVisible())
  const counterShown = () => t.win().contentView.children.some((v) => v.webContents === counter && v.getVisible() && v.getBounds().x >= 0 && v.getBounds().y >= 0)
  await counter.executeJavaScript(`document.getElementById('on').click()`, true)
  const header = (url) => `document.querySelector('.panes__column:has(.web-view) .browser-address__text')?.textContent === ${JSON.stringify(url)}`
  await t.until(header(`${countingUrl}on`), 'taken along a link')
  await t.call('pane.focus', { thread, pane: await browserPane() })
  await t.until(counterShown, 'shown')
  const [width, height] = t.win().getSize()
  await t.resize(width - 120, height - 60)
  await t.resize(width, height)
  await t.until(counterShown, 'shown after a resize')
  t.key('/')
  await t.until(`!document.querySelector('.app__sidebar')`, 'the sidebar hidden')
  t.key('/')
  await t.until(`Boolean(document.querySelector('.app__sidebar'))`, 'the sidebar shown')
  await t.until(counterShown, 'shown with the sidebar')
  await t.click('.app__settings')
  await t.until(`Boolean(document.querySelector('.settings'))`, 'Settings open')
  await t.until(() => !counterPlaced(), 'the page hidden under Settings')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.settings')`, 'Settings closed')
  await t.until(counterPlaced, 'the page placed again after Settings')
  await t.call('thread.start', { cwd: home, title: 'elsewhere' })
  await openRow(t, 'elsewhere')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'another thread shown')
  await t.until(() => !counterPlaced(), 'the page hidden with its thread')
  if (counter.isDestroyed()) t.fail('the page closed as its thread was left')
  await openRow(t, 'signing in')
  await t.until(`document.querySelector('.thread__title')?.textContent === 'signing in'`, 'the thread shown again')
  await t.until(counterPlaced, 'the page placed again with its thread')
  await t.until(header(`${countingUrl}on`), 'where the user took it')
  if (counter.isDestroyed() || pageAt(countingUrl) !== counter || counted !== 1) t.fail(`the page loaded again (loaded ${counted} times)`)
  counting.close()
  clickInto(t, counter)
  await t.until(`document.activeElement?.matches('.web-view')`, 'the pane focused again')

  // A page that refuses frames loads: it isn't framed.
  await t.call('pane.update', { thread, pane: await browserPane(), params: { url: refusingUrl } })
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

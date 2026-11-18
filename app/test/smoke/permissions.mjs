// A web page in a Browser pane asks, as in a browser: nothing's granted as the agent opens it; asking for notifications shows the ask
// in its pane, and the user's Allow answers the page; a check of the local network (as Okta FastPass does) is no
// until it's allowed there, and the page loads again to see it; a refusal is kept and not asked again; Settings lists
// the site, and Remove forgets it.
import { createServer } from 'node:http'
import { home, openRow, pageAt } from './common.mjs'

export default async function permissions(t) {
  const server = await new Promise((resolve) => { const s = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>asking</title>') }).listen(0, '127.0.0.1', () => resolve(s)) })
  const url = `http://127.0.0.1:${server.address().port}/`
  const site = `127.0.0.1:${server.address().port}`
  // The thread shown before, shown again after: the next area takes up where this one leaves off.
  const before = await t.run(`document.querySelector('.thread__title')?.textContent`)
  const thread = (await t.call('thread.start', { cwd: home, title: 'asking' })).id
  await t.until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('asking'))`, 'the thread listed')
  await t.run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('asking')).click()`)
  await t.until(`document.querySelector('.thread__title')?.textContent === 'asking'`, 'the thread open')
  // Opened by the agent: nothing granted.
  await t.call('pane.open', { thread, kind: 'browser', params: { url } })
  await t.until(() => pageAt(url)?.isLoading() === false && pageAt(url).getTitle() === 'asking', 'the page loaded')
  const page = () => pageAt(url)
  const inPage = (js) => page().executeJavaScript(js, true)
  if (await inPage('Notification.permission') !== 'denied') t.fail('notifications granted before anyone was asked')
  const ask = `document.querySelector('.browser-ask')?.textContent ?? ''`

  // Asked for notifications: the pane asks, and the page waits for the answer.
  await inPage(`window.answered = undefined; Notification.requestPermission().then((r) => { window.answered = r }); 0`)
  await t.until(`(${ask}).startsWith(${JSON.stringify(`${site} wants to show notifications`)})`, 'the pane asks for notifications')
  if (await inPage('window.answered') !== undefined) t.fail('the page answered before the user did')
  await t.click('.browser-ask button', 'Allow')
  await t.until(async () => await inPage('window.answered') === 'granted', 'the page told it was allowed')
  await t.until(`!document.querySelector('.browser-ask')`, 'the ask gone')
  if (await inPage('Notification.permission') !== 'granted') t.fail('notifications not granted after Allow')

  // The local network, checked: no, and asked; allowed, the page loads again and sees it.
  const network = `navigator.permissions.query({ name: 'loopback-network' }).then((r) => r.state)`
  if (await inPage(network) !== 'denied') t.fail('the local network granted before anyone was asked')
  await t.until(`(${ask}).startsWith(${JSON.stringify(`${site} wants to reach apps on this`)})`, 'the pane asks for the local network')
  if (await inPage(network) !== 'denied') t.fail('the local network granted while asking')
  await inPage(`window.before = true`)
  await t.click('.browser-ask button', 'Allow')
  await t.until(async () => page()?.isLoading() === false && await inPage('window.before') === undefined, 'the page loaded again')
  if (await inPage(network) !== 'granted') t.fail('the local network not granted after Allow')

  // Refused: kept, and not asked again.
  await inPage(`window.camera = undefined; navigator.mediaDevices.getUserMedia({ video: true }).then(() => { window.camera = 'yes' }, (e) => { window.camera = e.name }); 0`)
  await t.until(`(${ask}).startsWith(${JSON.stringify(`${site} wants to use the camera`)})`, 'the pane asks for the camera')
  await t.click('.browser-ask button', "Don't allow")
  await t.until(async () => await inPage('window.camera') === 'NotAllowedError', 'the page refused the camera')
  await inPage(`window.camera = undefined; navigator.mediaDevices.getUserMedia({ video: true }).then(() => { window.camera = 'yes' }, (e) => { window.camera = e.name }); 0`)
  await t.until(async () => await inPage('window.camera') === 'NotAllowedError', 'refused again at once')
  if (await t.run(ask)) t.fail('asked again after the user refused')

  // Settings lists the site, with what it may use; Remove forgets it.
  await t.click('.app__settings')
  await t.click('.settings__nav button', 'General')
  const listed = `[...document.querySelectorAll('.site-permission')].find((row) => row.textContent.includes(${JSON.stringify(site)}))`
  await t.until(`${listed}?.textContent.includes('Allowed: Notifications, Apps on this') && ${listed}.textContent.includes('Blocked: Camera')`, 'the site in Settings')
  await t.run(`${listed}.querySelector('button').click()`)
  await t.until(`!${listed}`, 'the site forgotten')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.settings')`, 'Settings closed')
  if (await inPage('Notification.permission') !== 'denied') t.fail('notifications still granted once forgotten')

  await t.call('pane.close', { thread, pane: (await t.call('thread.list')).find((x) => x.id === thread).panes.find((p) => p.kind === 'browser').id })
  server.close()
  if (before) {
    await openRow(t, before)
    await t.until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(before)}`, `back to ${before}`)
  }
}

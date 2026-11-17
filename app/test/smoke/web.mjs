// Web access: the daemon serves the same window to a browser, to devices paired from Settings → Web access, by their
// cookie: a phone's layout there, images and artifacts over it, another origin refused, a code typed in, a device revoked.
import { BrowserWindow } from 'electron'
import { fitted } from './common.mjs'

export default async function web(t, s) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  await t.call('settings.set', { key: 'web.port', value: port })
  await t.call('settings.set', { key: 'web.access', value: 'local' })
  await t.click('.app__settings')
  await t.run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await t.until(`[...document.querySelectorAll('.web-access button')].some((b) => b.textContent === 'Pair a device')`, 'Pair a device')
  await t.click('.web-access button', 'Pair a device')
  await t.until(`Boolean(document.querySelector('.web-pair__qr svg'))`, 'a pairing link and its QR code')
  const url = await t.run(`document.querySelector('.web-pair__link').textContent`)
  if (!new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=`).test(url)) t.fail(`pairing link ${url}`)
  const main = t.win()
  const desktop = t.on(() => main.webContents, 'desktop')
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  const b = t.on(() => browser.webContents, 'browser')
  await browser.loadURL(url)
  await b.until(`window.superego.web === true && location.href === 'http://127.0.0.1:${port}/'`, 'web bridge, the ticket out of the address bar')
  // Paired: the device is listed, and the ticket is spent.
  await desktop.until(`!document.querySelector('.web-pair') && document.querySelectorAll('.web-device').length === 1`, 'the paired device listed')
  desktop.key('Escape', [])
  await desktop.until(`!document.querySelector('.settings')`, 'Settings closed')
  const helloRow = `[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('hello from smoke'))`
  await b.until(`Boolean(${helloRow})`, 'threads in the browser')
  await b.run(`${helloRow}.click()`)
  await b.until(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'a transcript in the browser')

  // A phone: one column, the threads in a drawer from the bar at the top.
  browser.setContentSize(390, 844)
  await b.until(`Boolean(document.querySelector('.app__mobilebar')) && !document.querySelector('.app__sidebar')`, 'phone layout')
  await b.click('.app__mobilebar button')
  await b.until(`Boolean(document.querySelector('.app.has-drawer .app__sidebar'))`, 'drawer open')
  await b.run(`${helloRow}.click()`)
  await b.until(`!document.querySelector('.app__sidebar')`, 'drawer closes on picking a thread')
  // A thread finishing while another is shown: Unread, beside Settings in the drawer, has it, and goes there.
  await b.call('thread.start', { title: 'unread on the phone', prompt: 'finish while away' })
  await b.click('.app__mobilebar button')
  await b.until(`Boolean(document.querySelector('.app__footer .unread-button'))`, 'Unread beside Settings on a phone')
  await b.until(`Boolean(document.querySelector('.app__footer .ego__button'))`, 'Ego beside Settings on a phone')
  await b.click('.app__footer .unread-button')
  await b.until(`[...document.querySelectorAll('.unread-list .palette__list li')].some((i) => i.textContent.includes('unread on the phone'))`, 'the finished thread in Unread')
  await b.run(`[...document.querySelectorAll('.unread-list .palette__list li')].find((i) => i.textContent.includes('unread on the phone')).click()`)
  await b.until(`document.querySelector('.app__mobilebar')?.textContent.includes('unread on the phone') && !document.querySelector('.app__sidebar')`, 'Unread went to the thread')
  await b.until(`!document.querySelector('.unread-list')`, 'the unread list closed')
  // A data view on a phone: the skills, placed as a space, switched to from the drawer's foot and drawn from data.
  await b.call('app.settings.set', { key: 'app.layout', value: { place: { 'skills.view': 'space' } } }, 'app')
  await b.click('.app__mobilebar button')
  await b.until(`Boolean(document.querySelector('.app__drawer-bar [aria-label="Skills"]'))`, 'Skills among the spaces in the drawer')
  await b.click('.app__drawer-bar [aria-label="Skills"]')
  await b.until(`document.querySelector('.data-view--space')?.textContent.includes('$smoke-skill') && document.querySelector('.data-view--space')?.textContent.includes('Checks the smoke.')`, 'the skills data view in the drawer')
  await b.click('.app__drawer-bar [aria-label="Threads"]')
  await b.until(`Boolean(document.querySelector('.app__sidebar .superego-list-item'))`, 'back to the threads in the drawer')
  // Ego from the drawer: its thread shown, and its Clear in the thread's sheet (the title bar's, on a phone).
  await b.click('.app__footer .ego__button')
  await b.until(`!document.querySelector('.app__sidebar') && Boolean(document.querySelector('button.app__mobiletitle'))`, "Ego's thread shown on a phone")
  await b.click('button.app__mobiletitle')
  await b.until(`Boolean(document.querySelector('.thread-sheet .ego__clear')) && !document.querySelector('.thread-sheet .thread__archive')`, "Ego's Clear in the thread's sheet")
  // The model button there shows the details (beside the thread, wide) in the sheet.
  await b.click('.thread-sheet .threads-model')
  await b.until(`Boolean(document.querySelector('.thread-sheet .threads-details'))`, 'thread details in the sheet')
  await b.click('.thread-sheet .threads-model')
  await b.click('.app__scrim--sheet')
  await b.until(`!document.querySelector('.thread-sheet')`, 'the sheet closed')
  // No space and no picker on a phone: the bar stays, with the thread's sheet and Settings, and Settings has the layout
  // to edit (in a browser, in a dialog) back to the defaults.
  await b.call('app.settings.set', { key: 'app.layout', value: { place: { 'threads.list': null, 'core.picker': null } } }, 'app')
  await b.until(`Boolean(document.querySelector('.app__mobilebar .app__settings')) && Boolean(document.querySelector('.app__mobilebar button.app__mobiletitle')) && !document.querySelector('.app__mobilebar [aria-label="Threads"]')`, 'a phone with no space keeps its bar and Settings')
  await b.click('.app__mobilebar .app__settings')
  await b.until(`Boolean(document.querySelector('.settings__nav button'))`, 'Settings on a phone')
  await b.click('.settings__nav button', 'General')
  await b.until(`[...document.querySelectorAll('.setting[data-key="app.layout"] button')].some((b) => b.textContent === 'Edit layout…')`, 'the layout in Settings')
  await b.click('.setting[data-key="app.layout"] button', 'Edit layout…')
  await b.until(`Boolean(document.querySelector('.layout-editor__text')) && !document.querySelector('.settings')`, "the browser's layout in a dialog")
  await b.type('.layout-editor__text', '{ "place": { "threads.list": "sidebar" } }')
  await b.click('.layout-editor button', 'Save')
  await b.until(`document.querySelector('.layout-editor .layout-note.is-problem')?.textContent.includes('no place "sidebar"')`, 'a layout that does not read, noted')
  await b.type('.layout-editor__text', '{}')
  await b.click('.layout-editor button', 'Save')
  await b.until(`!document.querySelector('.layout-editor') && Boolean(document.querySelector('.app__mobilebar [aria-label="Threads"]'))`, 'the layout back from the dialog')
  await b.call('app.settings.set', { key: 'app.layout', value: {} }, 'app')

  // Images over the WebSocket, on a phone: the thread's images load, and the lightbox fills the screen.
  await b.click('.app__mobilebar button')
  await b.until(`Boolean(document.querySelector('.app.has-drawer .app__sidebar'))`, 'drawer open again')
  await b.run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('show me the screens')).click()`)
  // Each is read as it nears the screen: scrolled to in turn.
  await b.until(`(() => { document.querySelector('.images--single')?.scrollIntoView({ block: 'center' }); return Boolean(document.querySelector('.images--single .images__frame.is-ready')) })()`, 'an image read over the web')
  await b.until(`(() => { document.querySelector('.images--carousel')?.scrollIntoView({ block: 'center' }); return Boolean(document.querySelector('.images--carousel .images__frame.is-ready')) })()`, 'images read over the web')
  await b.click('.images--single .images__frame')
  await b.until(`document.querySelector('.lightbox .lightbox__image.is-ready') && document.querySelector('.lightbox').getBoundingClientRect().width === innerWidth`, 'lightbox on a phone')
  await b.click('.lightbox__bar button[aria-label="Close"]')
  await b.until(`!document.querySelector('.lightbox')`, 'lightbox closed on a phone')
  await b.run(`(() => { const f = document.querySelectorAll('.images--single')[1]; f.scrollIntoView({ block: 'center' }); f.querySelector('.images__frame').click() })()`)
  await b.until(fitted, 'a tall image fitted on a phone')
  await b.click('.lightbox__bar button[aria-label="Close"]')
  await b.until(`!document.querySelector('.lightbox')`, 'tall lightbox closed on a phone')

  // An artifact over the web, by the device's cookie: the page, and a file it links to (from its sandbox's own origin).
  await desktop.call('file.write', { thread: s.paned, path: 'pic.html', content: `<img src="dot.svg" onload="parent.postMessage('loaded', '*')" onerror="parent.postMessage('failed', '*')">` })
  await desktop.call('file.write', { thread: s.paned, path: 'dot.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' })
  await b.run(`(() => {
    addEventListener('message', (event) => { window.smokeArtifact = event.data }, { once: true })
    const frame = document.createElement('iframe')
    frame.sandbox = 'allow-scripts'
    frame.src = window.superego.artifactUrl('local', '${s.paned}', 'pic.html')
    document.body.append(frame)
  })()`)
  const artifact = await b.until(`window.smokeArtifact`, "an artifact's file over the web", 5000)
  if (artifact !== 'loaded') t.fail(`an artifact's file over the web: ${artifact}`)
  // Another origin's WebSocket is refused, cookie or not (localhost is this computer, but not this page's origin).
  const crossSite = await b.run(`new Promise((resolve) => { const ws = new WebSocket('ws://localhost:' + location.port + '/rpc'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('refused') })`)
  if (crossSite !== 'refused') t.fail(`a WebSocket from another origin got in: ${crossSite}`)

  // A page on the home screen keeps its own cookies: a browser of its own. The link again is spent; it asks for a code.
  browser.setContentSize(1100, 760)
  const phone = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: 'smoke-phone' } })
  const p = t.on(() => phone.webContents, 'phone')
  await phone.loadURL(url)
  await p.until(`document.activeElement?.classList.contains('pair-gate__input') && document.querySelector('.pair-gate__error')?.textContent.includes('used already') && location.hash === ''`, 'a spent link refused, the code form focused')
  const submitCode = (value) => p.run(`(() => { document.querySelector('.pair-gate__input').value = ${JSON.stringify(value)}; document.querySelector('.pair-gate').requestSubmit() })()`)
  await submitCode('AAAA-AAAA')
  await p.until(`document.querySelector('.pair-gate__error')?.textContent.includes('isn’t right')`, 'a wrong code refused')
  const { code } = await desktop.call('web.pair')
  await submitCode(code.toLowerCase())
  await p.until(`!document.querySelector('.pair-gate')`, 'the code form gone')
  await p.until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'threads after typing the code')
  // Revoked: its connection closes at once, and it asks to be paired again; the other browser stays.
  const devices = await desktop.call('web.devices')
  if (devices.length !== 2) t.fail(`devices: ${JSON.stringify(devices)}`)
  const newest = devices.reduce((a, b) => a.created > b.created ? a : b)
  await desktop.call('web.revoke', { id: newest.id })
  await p.until(`Boolean(document.querySelector('.pair-gate'))`, 'a revoked device asked to pair again')
  await b.until(`!document.querySelector('.pair-gate') && [...document.querySelectorAll('.superego-list-item')].length > 0`, 'the other device still in')
  phone.destroy()
  browser.destroy()
  await t.call('settings.set', { key: 'web.access', value: 'off' })
}

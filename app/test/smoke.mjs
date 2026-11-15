// Headless end-to-end: the real app, the real daemon (scripted model), driven through the renderer.
// Phase "first" creates a thread and chats; phase "reopen" is a fresh app process that must find it on the same
// daemon, which outlived the first app. Run by test/smoke.sh.
import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'

const phase = process.env.SUPEREGO_SMOKE_PHASE ?? 'first'
import { mkdirSync as makeDir, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const fail = async (message) => {
  console.error(`smoke(${phase}): FAIL ${message}`)
  const window = BrowserWindow.getAllWindows()[0]
  if (window) console.error('POPOVER:', await window.webContents.executeJavaScript(`document.querySelector('.superego-font-picker__popover')?.textContent ?? 'none'`).catch(String))
  if (window) console.error('ROWS:', await window.webContents.executeJavaScript(`[...document.querySelectorAll('.machine-row')].map((r) => r.textContent).join(' | ')`).catch(String))
  if (window) console.error('DOM:', (await window.webContents.executeJavaScript('document.body.innerText').catch((e) => String(e))).slice(0, 2000))
  try { console.error('daemon.log:', readFileSync(`${process.env.SUPEREGO_HOME}/daemon.log`, 'utf8').slice(-2000)) } catch {}
  app.exit(1)
}
// Any uncaught error in the main process fails the run; in the app it would be an error dialog.
process.on('uncaughtException', (error) => void fail(`uncaught in main: ${error.stack ?? error}`))
process.on('unhandledRejection', (error) => void fail(`unhandled in main: ${error?.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => console.error('renderer:', event.message)))
// The installed fonts, as the Local Font Access API gives them (only where the page has it): Chromium reads every font
// on the machine for the real list, 2,000-odd on a Mac, which takes over ten seconds alone and minutes beside other runs.
const FONTS = ['Arial', 'Courier', 'Georgia', 'Helvetica', 'Menlo', 'Monaco', 'Times']
app.on('web-contents-created', (_e, contents) => contents.on('dom-ready', () => void contents.executeJavaScript(
  `if (window.queryLocalFonts) window.queryLocalFonts = async () => ${JSON.stringify(FONTS)}.map((family) => ({ family }))`).catch(() => {})))
const deadline = setTimeout(() => fail('timed out'), 90_000)

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
  const before = await run(`window.superego.machines().then((list) => list.find((m) => m.id === 'local'))`)
  change()
  await until(`document.querySelector('.service-notice')?.textContent.includes('Restart required')`, 'restart required shown')
  await run(`[...document.querySelectorAll('.service-notice button')].find((b) => b.textContent === 'Restart now').click()`)
  await until(`!document.querySelector('.service-notice')`, 'restart done', 40_000)
  const after = await run(`window.superego.call('local', 'hello', { client: 'smoke', version: 1 })`)
  if (after.machine.id !== before.machine.id || !(await run(`window.superego.call('local', 'thread.list', {})`)).length) { await fail('restart lost the machine or its threads'); throw new Error('failed') }
  return after
}
/** With SUPEREGO_SMOKE_SHOTS=<dir>, a screenshot of the window at this point. */
const shot = async (name) => {
  if (!process.env.SUPEREGO_SMOKE_SHOTS) return
  const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
  writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/${name}.png`, image.toPNG())
}
const run = (js, gesture = false) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js, gesture)

await until(`Boolean(document.querySelector('.threads.is-ready'))`, 'local machine connected')

if (phase === 'first') {
  const id = await run(`window.superego.call('local', 'thread.create', { title: '' }).then((s) => s.id)`)
  await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: 'hello from smoke' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'thread in sidebar')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'answer rendered')
  await until(`document.querySelector('.thread__profile')?.textContent === 'default'`, "the user's default profile, shown in the header")
  await until(`document.querySelector('.smoke-badge')?.textContent === 'profile ui: hello from smoke'`, "the profile's own UI, loaded at runtime")
  await until(`[...document.querySelectorAll('.extension-failed')].some((e) => e.textContent.includes('badge failed to draw') && e.textContent.includes('smoke crash'))`, 'a view that throws, contained in its place')
  await run(`globalThis.__smokeFixed = true; [...document.querySelectorAll('.extension-failed')].find((e) => e.textContent.includes('badge failed')).querySelector('button').click()`)
  await until(`document.querySelector('.smoke-fixed') && !document.querySelector('.extension-failed')`, 'drawn again on Retry')
  await shot('main')
  // Type into the composer like a user: React needs the native setter and an input event.
  await run(`(() => {
    const ta = document.querySelector('.composer textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'typed message')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'typed answer rendered')
  // Your messages read as Markdown too, each newline kept: a thread link, code, a highlighted block; a lone * stays.
  const said = `From [this thread](thread:${id}):\nrun \`pnpm test\` * twice\n\n\`\`\`ts\nconst a = 1\n\`\`\``
  await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: ${JSON.stringify(said)} })`)
  await until(`(() => { const m = [...document.querySelectorAll('.msg--user')].at(-1); return Boolean(m?.querySelector('a.thread-ref') && m.querySelector('p br')) && m.querySelector('p code')?.textContent === 'pnpm test' && m.textContent.includes(' * twice') && Boolean(m.querySelector('pre code.is-highlighted span')) })()`, 'a user message as Markdown')
  await shot('user-markdown')
  // Naming a skill: $ offers this machine's skills as you type; ⇥ takes one, and the message carries it.
  await run(`(() => {
    const ta = document.querySelector('.composer textarea')
    ta.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'try $smo')
    ta.setSelectionRange(8, 8)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.completions')?.textContent.includes('$smoke-skill') && document.querySelector('.completions').textContent.includes('Checks the smoke.')`, 'skills offered')
  await run(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`)
  await until(`document.querySelector('.composer textarea').value === 'try $smoke-skill ' && !document.querySelector('.completions')`, 'skill taken')
  await run(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await until(`[...document.querySelectorAll('.attachment--skill')].some((chip) => chip.textContent.includes('smoke-skill'))`, 'skill sent with the message')
  // A web link in the thread: the button beside it opens the page in a pane, not the browser, even a page that refuses
  // to be framed (as most sites do).
  const { createServer } = await import('node:http')
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; default-src 'self'" })
    res.end('<title>framed page</title><p>hello')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const page = `http://127.0.0.1:${site.address().port}/page`
  await run(`window.superego.call('local', 'thread.submit', { id: '${id}', text: 'see ${page}' })`)
  await until(`Boolean(document.querySelector('.md a[href="${page}"] + .md__pane-link'))`, 'pane button beside a web link')
  await run(`document.querySelector('.md a[href="${page}"] + .md__pane-link').click()`)
  await until(`Boolean(document.querySelector('.frame-pane iframe[src="${page}"]'))`, 'link opened in a preview pane')
  const framed = async () => {
    const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find((f) => f.url === page)
    return frame ? frame.executeJavaScript('document.title').catch(() => '') : ''
  }
  for (let i = 0; i < 100 && await framed() !== 'framed page'; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  if (await framed() !== 'framed page') await fail('a page that refuses framing loads in its pane')
  site.close()
  // ⌃O lists the links the thread drew (each claimed by what opens it): the web page and the thread it names.
  const press = (keyCode, modifiers) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  press('o', ['control'])
  await until(`(() => { const items = [...document.querySelectorAll('.links .palette__list li')].map((li) => li.textContent); return items.some((t) => t.includes('127.0.0.1')) && items.some((t) => t.includes('this thread')) })()`, 'links listed')
  press('Escape', [])
  await until(`!document.querySelector('.links')`, 'links closed')
  // ask-user: a replayed agent asks; the question shows above the composer and the thread as needing you; an answer
  // from the card reaches it, and it carries on.
  await run(`window.superego.call('local', 'settings.set', { key: 'agent.model', value: 'replay/replay' })`)
  const asking = await run(`window.superego.call('local', 'thread.create', {}).then((s) => window.superego.call('local', 'thread.submit', { id: s.id, text: 'pick a colour' }).then(() => s.id))`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('pick a colour'))`, 'new thread listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('pick a colour'))?.click()`)
  await until(`document.querySelector('.ask-user')?.textContent.includes('Which colour?')`, 'question card above the composer')
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('pick a colour') && li.querySelector('.superego-status--blocked'))`, 'thread marked as needing you')
  // Sent while it's busy, a follow-up shows at once as waiting over the composer, and goes in when the agent is done;
  // one taken back with its × never does.
  await run(`window.superego.call('local', 'thread.submit', { id: '${asking}', text: 'then paint it', whenBusy: 'followUp' })`)
  await until(`document.querySelector('.queued-row')?.textContent.includes('then paint it') && document.querySelector('.queued-row').textContent.includes('Queued')`, 'follow-up shown as queued')
  await run(`window.superego.call('local', 'thread.submit', { id: '${asking}', text: 'never mind this', whenBusy: 'followUp' })`)
  await until(`document.querySelectorAll('.queued-row').length === 2`, 'second follow-up queued')
  await run(`[...document.querySelectorAll('.queued-row')].find((row) => row.textContent.includes('never mind this')).querySelector('.queued-row__remove').click()`)
  await until(`document.querySelectorAll('.queued-row').length === 1`, 'follow-up taken back')
  // One sent now steers: it goes in after the step (the question answered), ahead of the follow-up.
  await run(`window.superego.call('local', 'thread.submit', { id: '${asking}', text: 'make it bold', whenBusy: 'followUp' })`)
  await until(`Boolean([...document.querySelectorAll('.queued-row')].find((row) => row.textContent.includes('make it bold'))?.querySelector('.queued-row__now'))`, 'follow-up offered to send now')
  await run(`[...document.querySelectorAll('.queued-row')].find((row) => row.textContent.includes('make it bold')).querySelector('.queued-row__now').click()`)
  await until(`(() => { const row = [...document.querySelectorAll('.queued-row')].find((r) => r.textContent.includes('make it bold')); return row?.textContent.includes('Steers after this step') && !row.querySelector('.queued-row__now') })()`, 'sent now: steers')
  await run(`[...document.querySelectorAll('.ask-user button')].find((b) => b.querySelector('.ask-user__option-label')?.textContent === 'blue').click()`)
  await until(`!document.querySelector('.ask-user') && document.querySelector('.ask-user-asked')?.textContent.includes('blue') && document.querySelector('.transcript').textContent.includes('Blue it is.')`, 'answered, agent carried on')
  await until(`(() => { const text = document.querySelector('.transcript').textContent; return text.includes('make it bold') && text.indexOf('make it bold') < text.indexOf('Blue it is.') })()`, 'the one sent now went in after the step, before the answer')
  await until(`!document.querySelector('.queued-row') && document.querySelector('.transcript').textContent.includes('then paint it') && document.querySelector('.transcript').textContent.includes('Noted for later.') && !document.querySelector('.transcript').textContent.includes('never mind this')`, 'queued follow-up went in, the one taken back not')
  // images: a replayed agent shows images (show_images), drawn in the thread: one alone, a grid, a carousel; a file
  // gone by then shows as broken; any opens in the lightbox, which zooms, goes through the set, and closes on Escape.
  const shots = `${process.env.SUPEREGO_HOME}/shots`
  makeDir(shots, { recursive: true })
  const picture = (name, width, height, hue) => {
    const pixels = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      // A gradient with a grid over it, so zooming and panning show.
      const line = x % 80 < 2 || y % 80 < 2
      const [r, g, b] = [hue, (hue + 90) % 256, (hue + 170) % 256].map((c, i) => Math.round(c * (0.55 + 0.45 * (i === 0 ? x / width : y / height))))
      pixels.set(line ? [250, 250, 250, 255] : [b, g, r, 255], (y * width + x) * 4)
    }
    writeFileSync(`${shots}/${name}.png`, nativeImage.createFromBitmap(pixels, { width, height }).toPNG())
  }
  picture('wide', 1280, 720, 40)
  picture('a', 640, 480, 200); picture('b', 640, 480, 120); picture('gone', 480, 640, 10)
  for (const n of [1, 2, 3, 4, 5, 6]) picture(String(n), 900 - n * 40, 600, n * 37)
  const showing = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(shots)} }).then((s) => window.superego.call('local', 'thread.submit', { id: s.id, text: 'show me the screens' }).then(() => s.id))`)
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${showing}')?.status.state === 'done')`, 'images shown by the agent')
  // One shown file gone from the machine before anyone looks: that one is broken, the rest still show.
  const shownDir = `${process.env.SUPEREGO_HOME}/attachments/${showing}/shown`
  rmSync(`${shownDir}/${readdirSync(shownDir).find((name) => name.endsWith('-gone.png'))}`)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('show me the screens'))?.click()`)
  // Opened, it lands at its end, and stays there as what's in it is laid out.
  await until(`(() => { const s = document.querySelector('.thread__scroll'); return Boolean(document.querySelector('.images--carousel')) && s.scrollHeight - s.scrollTop - s.clientHeight < 2 })()`, 'the thread opened at its end')
  // Each is read as it nears the screen: the first, above, once scrolled to (and kept in view while it loads).
  await until(`(() => { document.querySelector('.images--single')?.scrollIntoView({ block: 'center' }); return document.querySelector('.images--single .images__frame.is-ready') && document.querySelector('.images--single .images__caption')?.textContent === 'The home page, at full width' })()`, 'a single image, loaded, with its caption')
  await until(`document.querySelectorAll('.images--grid .images__frame').length === 3 && document.querySelectorAll('.images--grid .images__frame.is-ready').length === 2 && document.querySelector('.images--grid .images__frame.is-broken')?.textContent.includes('Image not found')`, 'a grid, with the gone one broken')
  await until(`document.querySelector('.images--grid .images__title')?.textContent === 'Before and after'`, 'the grid titled')
  await until(`document.querySelector('.images--carousel .images__count')?.textContent === '1 / 6' && Boolean(document.querySelector('.images--carousel .images__slide .images__frame.is-ready'))`, 'a carousel at its first')
  // Not folded away with the run's steps: the images are in the thread as it reads.
  if (await run(`Boolean(document.querySelector('details:not([open]) .images'))`)) await fail('images folded into the run')
  await run(`document.querySelector('.images--carousel .images__nav--next').click()`)
  await until(`document.querySelector('.images--carousel .images__count')?.textContent === '2 / 6' && document.querySelector('.images--carousel .images__caption')?.textContent === 'Second'`, 'carousel moved on by its button')
  await run(`(() => { const c = document.querySelector('.images__carousel'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })()`)
  await until(`document.querySelector('.images--carousel .images__count')?.textContent === '3 / 6'`, 'carousel moved on by →')
  await until(`(() => { const t = document.querySelector('.images__track'); return Math.abs(t.scrollLeft - 2 * t.clientWidth) < 1 })()`, 'carousel settled on the third', 5000)
  await run(`document.querySelector('.images--single').scrollIntoView({ block: 'start' })`)
  await new Promise((r) => setTimeout(r, 300))
  await shot('images')
  await run(`document.querySelector('.images--grid').scrollIntoView({ block: 'start' })`)
  await new Promise((r) => setTimeout(r, 300))
  await shot('images-grid')
  nativeTheme.themeSource = 'light'
  await new Promise((r) => setTimeout(r, 400))
  await shot('images-grid-light')
  nativeTheme.themeSource = 'system'
  // The lightbox: the grid's first, then → to the next; zoom in and out; Escape closes it and the focus goes back.
  await run(`document.querySelector('.images--grid .images__frame').focus(); document.querySelector('.images--grid .images__frame').click()`)
  await until(`document.querySelector('.lightbox .lightbox__image.is-ready') && document.querySelector('.lightbox__caption')?.textContent === 'Before' && document.activeElement === document.querySelector('.lightbox')`, 'lightbox open, focused')
  await new Promise((r) => setTimeout(r, 400))
  await shot('lightbox')
  const key2 = (key) => run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`)
  await key2('ArrowRight')
  await until(`document.querySelector('.lightbox__caption')?.textContent === 'After' && document.querySelector('.lightbox__count')?.textContent === '2 / 3' && Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'lightbox → next image')
  await run(`document.querySelector('.lightbox__bar button[aria-label="Zoom in"]').click()`)
  await until(`Boolean(document.querySelector('.lightbox__stage.is-zoomed')) && document.querySelector('.lightbox__image').style.transform.includes('scale(2.5)')`, 'lightbox zoomed')
  await new Promise((r) => setTimeout(r, 300))
  await shot('lightbox-zoomed')
  await key2('0')
  await until(`!document.querySelector('.lightbox__stage.is-zoomed')`, 'lightbox back to fit')
  await key2('ArrowRight')
  await until(`document.querySelector('.lightbox__broken')?.textContent.includes('gone.png')`, 'the gone one, broken in the lightbox too')
  await key2('Escape')
  await until(`!document.querySelector('.lightbox') && document.activeElement === document.querySelector('.images--grid .images__frame')`, 'lightbox closed by Escape, focus back')
  // Its answer's own images, inline: read from the thread's folder (by a relative path, file:// or a whole one), fitted
  // to the column; one outside the folder is refused, quietly, saying why. Any opens in the same lightbox, through the
  // message's images.
  const inline = `[...document.querySelectorAll('.msg__text .image-frame--inline')]`
  await until(`(() => { const m = ${inline}; m[0]?.scrollIntoView({ block: 'center' }); return m.length === 4 })()`, 'inline images in the answer')
  await until(`${inline}.slice(0, 3).every((f) => f.classList.contains('is-ready') && f.querySelector('img').src.startsWith('blob:'))`, 'inline images read from the thread’s folder')
  await until(`(() => { const f = ${inline}[3]; return f.classList.contains('is-broken') && f.textContent === 'Elsewhere' && f.title.includes("outside the thread's folder") })()`, 'an image outside the folder, refused')
  if (!await run(`${inline}.every((f) => f.getBoundingClientRect().right <= f.closest('.msg').getBoundingClientRect().right + 0.5)`)) await fail('inline images overflow the message')
  await run(`${inline}[3].scrollIntoView({ block: 'center' })`)
  await new Promise((r) => setTimeout(r, 300))
  await shot('message-images')
  await run(`${inline}[0].click()`)
  await until(`document.querySelector('.lightbox .lightbox__image.is-ready') && document.querySelector('.lightbox__count')?.textContent === '1 / 4'`, 'an inline image in the lightbox')
  await new Promise((r) => setTimeout(r, 400))
  await shot('message-images-lightbox')
  await key2('ArrowRight')
  await until(`document.querySelector('.lightbox__count')?.textContent === '2 / 4' && Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'lightbox → the message’s next image')
  await key2('Escape')
  await until(`!document.querySelector('.lightbox')`, 'inline lightbox closed by Escape')
  // A file rewritten after it showed: the window coming back to the front checks it, and the message shows the new one.
  const unchanged = await run(`${inline}[0].querySelector('img').src`)
  picture('wide', 1200, 720, 200)
  await run(`window.dispatchEvent(new Event('focus'))`)
  await until(`(() => { const f = ${inline}[0], img = f.querySelector('img'); return img.src !== ${JSON.stringify(unchanged)} && f.classList.contains('is-ready') && img.naturalWidth === 1200 })()`, 'a rewritten image swapped in')
  await run(`window.superego.call('local', 'settings.set', { key: 'agent.model', value: 'faux/faux-1' })`)
  void asking
  // Unread results elsewhere: a dot on Threads in the rail, and the thread's own in the list, to go to.
  await run(`window.superego.call('local', 'thread.create', { title: 'unread elsewhere', prompt: 'finish elsewhere' })`)
  await until(`Boolean(document.querySelector('.threads-rail__button .threads-rail__badge--done'))`, 'unread dot on Threads')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((i) => i.textContent.includes('unread elsewhere')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'unread elsewhere'`, 'went to the unread thread')
  // The sidebar's modes: the ··· menu (portalled, so a scrolling sidebar can't cut it off), ⌘\\ rail, ⌘I details.
  const key = async (keyCode, modifiers = ['meta']) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  await run(`document.querySelector('.threads-menu-trigger').click()`)
  await until(`[...document.querySelectorAll('.superego-menu .superego-menu__item')].some((i) => i.textContent.includes('Needs you first'))`, 'sidebar menu open')
  await shot('menu')
  await run(`[...document.querySelectorAll('.superego-menu .superego-menu__item')].find((i) => i.textContent.includes('Needs you first')).click()`)
  await until(`window.superego.call('app', 'settings.watch', {}).then((r) => r.value.values['app.sort'] === 'status')`, 'sorted by status')
  await key('\\')
  await until(`Boolean(document.querySelector('.threads-rail'))`, 'rail')
  await key('\\')
  await until(`Boolean(document.querySelector('.threads-session'))`, 'list again')
  await key('i')
  await until(`document.querySelector('.threads-details')?.textContent.includes('Machine')`, 'details pane')
  await key('i')
  await until(`!document.querySelector('.threads-details') && !document.querySelector('.app__aside')?.getBoundingClientRect().width`, 'details closed, its column gone')
  // The model in the title bar shows and hides them too; with the sidebar hidden, ⌘I turns them on and off as well.
  await until(`Boolean(document.querySelector('.app__titlebar .threads-model')?.textContent)`, 'the model in the title bar')
  await run(`document.querySelector('.threads-model').click()`)
  await until(`Boolean(document.querySelector('.threads-details')) && document.querySelector('.threads-model').classList.contains('is-on')`, 'details from the model button')
  await run(`document.querySelector('.threads-model').click()`)
  await until(`!document.querySelector('.threads-details')`, 'and off again')
  await key('/')
  await until(`!document.querySelector('.app__sidebar')`, 'sidebar hidden')
  await key('i')
  await until(`Boolean(document.querySelector('.threads-details'))`, 'details on with the sidebar hidden')
  await key('i')
  await until(`!document.querySelector('.threads-details') && !document.querySelector('.threads-model').classList.contains('is-on')`, 'and off')
  await key('/')
  await until(`Boolean(document.querySelector('.app__sidebar'))`, 'sidebar back')
  // Moving a view from its menu: the details from beside the thread into a pane and back, then the layout as text.
  const layoutNow = () => `window.superego.call('app', 'settings.watch', {}).then((r) => JSON.stringify(r.value.values['app.layout'] ?? {}))`
  const moveTo = async (button, place) => {
    await run(`document.querySelector('${button}').click()`)
    await until(`[...document.querySelectorAll('.view-menu .superego-menu__item')].some((i) => i.textContent === 'Move to')`, 'the view menu')
    await run(`[...document.querySelectorAll('.view-menu .superego-menu__item')].find((i) => i.textContent === 'Move to').click()`)
    await until(`Boolean(document.querySelector('.view-menu__places [data-place="${place}"]'))`, `Move to ${place}`)
    await run(`document.querySelector('.view-menu__places [data-place="${place}"]').click()`)
  }
  await key('i')
  await until(`Boolean(document.querySelector('.app__aside .threads-details'))`, 'details beside the thread')
  // A view that draws nothing takes no room beside the thread, nor its ···; with only such views, there's no aside.
  await until(`(() => {
    const aside = document.querySelector('.app__aside')
    const empty = document.createElement('div')
    empty.className = 'placed-view'
    empty.innerHTML = '<button class="view-menu__button"></button>'
    aside.append(empty)
    const hidden = getComputedStyle(empty).display === 'none' && getComputedStyle(aside).display !== 'none'
    const alone = Object.assign(document.createElement('aside'), { className: 'app__aside' })
    alone.append(empty)
    document.body.append(alone)
    const gone = getComputedStyle(alone).display === 'none'
    alone.remove()
    return hidden && gone
  })()`, 'an empty view hidden, and an aside of only those')
  await moveTo('.placed-view[data-view="threads.details"] .view-menu__button', 'pane')
  await until(`Boolean(document.querySelector('.panes__column .threads-details')) && !document.querySelector('.app__aside')`, 'details moved into a pane')
  await until(`${layoutNow()}.then((l) => l === JSON.stringify({ place: { 'threads.details': 'pane' } }))`, 'the layout keeping it in the pane menu')
  await moveTo('.panes__tab .view-menu__button', 'aside')
  await until(`Boolean(document.querySelector('.app__aside .threads-details')) && !document.querySelector('.panes__column .threads-details')`, 'details moved back beside the thread')
  // The layout as text: layout.json has the move, and the views at its head; Edit layout… opens it beside the thread.
  const layoutFile = `${process.env.SUPEREGO_HOME}/layout.json`
  const readLayout = () => { try { return readFileSync(layoutFile, 'utf8') } catch { return '' } }
  for (let i = 0; i < 50 && !readLayout().includes('//   threads.details'); i++) await new Promise((resolve) => setTimeout(resolve, 100))
  const written = readLayout()
  if (!written.includes('"threads.details": "aside"') || !written.includes('//   threads.details')) { await fail(`layout.json as written: ${written}`); throw new Error('failed') }
  await run(`document.querySelector('.placed-view[data-view="threads.details"] .view-menu__button').click()`)
  await until(`[...document.querySelectorAll('.view-menu .superego-menu__item')].some((i) => i.textContent === 'Edit layout…')`, 'the view menu again')
  await run(`[...document.querySelectorAll('.view-menu .superego-menu__item')].find((i) => i.textContent === 'Edit layout…').click()`)
  await until(`document.querySelector('.layout-note')?.textContent === 'Applied as you save'`, 'layout.json in the editor beside the thread')
  // A mistake is noted, and the last good layout stays; fixed, it applies.
  writeFileSync(layoutFile, '{ "place": { "threads.details": ')
  await until(`document.querySelector('.layout-note.is-problem')?.textContent.includes('Not JSON') && Boolean(document.querySelector('.layout-notice')) && Boolean(document.querySelector('.app__aside .threads-details'))`, 'bad JSON noted, the details kept')
  writeFileSync(layoutFile, '{ "place": { "threads.detail": "aside" } }')
  await until(`document.querySelector('.layout-note:not(.is-problem)')?.textContent.includes('not here now, kept for when they\\'re back: threads.detail') && !document.querySelector('.layout-notice')`, 'a view not here applied, and noted')
  writeFileSync(layoutFile, '{}')
  await until(`${layoutNow()}.then((l) => l === '{}') && !document.querySelector('.app__aside') && !document.querySelector('.layout-notice')`, 'the layout reset from the file')
  await run(`window.superego.call('local', 'thread.list', {}).then((list) => Promise.all(list.flatMap((t) => (t.panes ?? []).filter((p) => p.params?.path === ${JSON.stringify(layoutFile)}).map((p) => window.superego.call('local', 'pane.close', { id: t.id, pane: p.id })))))`)
  await until(`!document.querySelector('.layout-note')`, 'layout.json closed')
  await run(`window.superego.call('app', 'app.settings.set', { key: 'app.sort', value: 'created' })`)
  // ⌘K is commands only; ⌘L finds a thread by name and opens it.
  await key('k')
  await until(`Boolean(document.querySelector('.palette__input'))`, 'palette')
  await until(`[...document.querySelectorAll('.palette__list li')].every((li) => !li.textContent.includes('hello from smoke'))`, 'no threads in the palette')
  await key('Escape', [])
  // ⌘K shows a view where it fits and isn't, and resets the layout.
  const pick = async (query, title) => {
    await key('k')
    await until(`Boolean(document.querySelector('.palette__input'))`, `palette for ${query}`)
    await run(`(() => {
      const input = document.querySelector('.palette__input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await until(`document.querySelector('.palette__list li.is-active')?.textContent.includes(${JSON.stringify(title)})`, title)
    await key('Enter', [])
  }
  await pick('show thread details beside', 'Show Thread details beside the thread')
  await until(`Boolean(document.querySelector('.app__aside .threads-details'))`, 'details shown beside the thread from ⌘K')
  await pick('reset layout', 'Reset layout')
  await until(`!document.querySelector('.app__aside') && ${layoutNow()}.then((l) => l === '{}')`, 'the layout reset from ⌘K')
  await key('l')
  await until(`Boolean(document.querySelector('.navigator .palette__input'))`, 'navigator')
  await run(`(() => {
    const input = document.querySelector('.palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'hello')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.palette__list li.is-active')?.textContent.includes('hello from smoke')`, 'navigator finds the thread')
  await key('Enter', [])
  await until(`!document.querySelector('.palette__input') && document.querySelector('.thread__title')?.textContent === 'hello from smoke'`, 'navigator opened it')
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
  await until(`[...document.querySelectorAll('.action-log__table tr')].some((tr) => tr.textContent.includes('thread.select') && tr.textContent.includes('navigator'))`, 'navigator dispatch logged')
  await key('Escape', [])
  await until(`!document.querySelector('.action-log')`, 'log closed')
  // ⌘N: the New thread dialog refuses a folder that isn't there, then starts with the prompt on ⌘⏎.
  await key('n')
  await until(`Boolean(document.querySelector('.new-thread [aria-label="Prompt"]'))`, 'new thread dialog')
  await until(`[...document.querySelectorAll('.new-thread__check')].some((l) => l.textContent.includes('worktree'))`, "the worktrees extension's field in it")
  await new Promise((resolve) => setTimeout(resolve, 400))
  await shot('new-thread')
  const setValue = (selector, value) => run(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await setValue('.new-thread [aria-label="Project folder"]', '/nowhere/at/all')
  await setValue('.new-thread [aria-label="Prompt"]', 'hello from the dialog')
  await run(`[...document.querySelectorAll('.new-thread button')].find((b) => b.textContent.startsWith('Start')).click()`)
  await until(`document.querySelector('.new-thread__error')?.textContent.includes('No folder')`, 'missing folder refused')
  await setValue('.new-thread [aria-label="Project folder"]', process.env.SUPEREGO_HOME)
  await key('Enter', ['meta'])
  await until(`!document.querySelector('.new-thread') && document.querySelector('.transcript')?.textContent.includes('echo: hello from the dialog')`, 'started with the prompt')
  // Panes: in a git repo, the changes, the editor and an artifact the agent could have written, beside the thread.
  const { execFileSync: git } = await import('node:child_process')
  const repo = `${process.env.SUPEREGO_HOME}/repo`
  git('mkdir', ['-p', repo]); git('git', ['init', '-q', repo])
  writeFileSync(`${repo}/notes.md`, 'one\n')
  git('git', ['-C', repo, 'add', '.']); git('git', ['-C', repo, '-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-q', '-m', 'start'])
  const paned = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(repo)}, title: 'panes' }).then((s) => s.id)`)
  await run(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'notes.md', content: 'two\\n' })`)
  await run(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'page.html', content: '<body><script>document.body.dataset.ok = \\'yes\\'</script>An artifact</body>' })`)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('panes')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'panes'`, 'pane thread open')
  await key('d', ['meta', 'shift'])
  await until(`[...document.querySelectorAll('.diff-row--add')].some((r) => r.textContent.endsWith('+two'))`, 'changes pane shows the edit')
  await run(`window.superego.call('local', 'pane.open', { id: '${paned}', kind: 'editor', params: { path: 'notes.md' } })`)
  await until(`document.querySelector('.cm-content')?.textContent.includes('two')`, 'editor pane shows the file')
  // Rendered: read as a message reads, following the file as it changes; the editor kept behind it, for Live again.
  await run(`[...document.querySelectorAll('.file-editor__mode button')].find((b) => b.textContent === 'Rendered').click()`)
  await until(`document.querySelector('.file-editor__rendered .md')?.textContent.includes('two') && document.querySelector('.file-editor__host').hidden`, 'rendered shows the file')
  await run(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'notes.md', content: '# Notes\\n\\ntwo, and **three**, see [[page.html]]\\n' })`)
  await until(`document.querySelector('.file-editor__rendered h1')?.textContent === 'Notes' && document.querySelector('.file-editor__rendered strong')?.textContent === 'three' && document.querySelector('.file-editor__rendered a.md__file')?.textContent === 'page.html'`, 'rendered follows the file')
  if (await run(`Boolean(document.querySelector('.file-editor__rendered .cm-content, .file-editor__rendered [contenteditable]'))`)) { await fail('rendered is editable'); throw new Error('failed') }
  // Its links open files beside the thread, as a message's do.
  git('mkdir', ['-p', `${repo}/docs`]); writeFileSync(`${repo}/docs/plan.md`, 'the plan\n')
  await run(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'notes.md', content: '# Notes\\n\\ntwo, and **three**, see [[page.html]] and [the plan](docs/plan.md)\\n' })`)
  await until(`[...document.querySelectorAll('.file-editor__rendered a.md__file')].some((a) => a.textContent === 'the plan')`, 'a link to a file')
  await run(`[...document.querySelectorAll('.file-editor__rendered a.md__file')].find((a) => a.textContent === 'the plan').click()`)
  await until(`[...document.querySelectorAll('.panes__tab')].some((t) => t.textContent.startsWith('plan.md'))`, 'the link opened the file beside')
  const plan = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${paned}').panes.find((p) => p.params?.path === 'docs/plan.md').id)`)
  await run(`window.superego.call('local', 'pane.close', { id: '${paned}', pane: '${plan}' })`)
  await until(`![...document.querySelectorAll('.panes__tab')].some((t) => t.textContent.startsWith('plan.md'))`, 'and closed')
  // Its HTML (sanitized) and images, read from beside it: a <picture> shows the source for the app's theme.
  const svg = (width) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10"><rect width="${width}" height="10" fill="teal"/></svg>`
  git('mkdir', ['-p', `${repo}/docs/img`])
  writeFileSync(`${repo}/docs/img/light.svg`, svg(40)); writeFileSync(`${repo}/docs/img/dark.svg`, svg(30)); writeFileSync(`${repo}/docs/img/plain.svg`, svg(20))
  writeFileSync(`${repo}/docs/guide.md`, '# Guide\n\ntwo, and **three**\n\n<picture><source media="(prefers-color-scheme: dark)" srcset="img/dark.svg"><img src="img/light.svg" alt="diagram" onerror="document.body.dataset.pwned = 1"></picture>\n\n![plain](img/plain.svg)\n\n<script>document.body.dataset.pwned = 1</script>\n')
  const editorPaneId = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${paned}').panes.find((p) => p.kind === 'editor').id)`)
  await run(`window.superego.call('local', 'pane.update', { id: '${paned}', pane: '${editorPaneId}', params: { path: 'docs/guide.md' } })`)
  const imageWidths = `[...document.querySelectorAll('.file-editor__rendered img')].map((i) => i.src.startsWith('blob:') && i.complete ? i.naturalWidth : 0).join(',')`
  nativeTheme.themeSource = 'light'
  await until(`${imageWidths} === '40,20'`, 'rendered images, the light source')
  nativeTheme.themeSource = 'dark'
  await until(`${imageWidths} === '30,20'`, 'rendered images, the dark source')
  nativeTheme.themeSource = 'system'
  if (await run(`Boolean(document.body.dataset.pwned || document.querySelector('.file-editor__rendered script, .file-editor__rendered [onerror]'))`)) { await fail('rendered HTML kept a script or handler'); throw new Error('failed') }
  await run(`window.superego.call('local', 'pane.update', { id: '${paned}', pane: '${editorPaneId}', params: { path: 'notes.md' } })`)
  await until(`document.querySelector('.file-editor__rendered h1')?.textContent === 'Notes'`, 'back to the notes')
  await run(`[...document.querySelectorAll('.file-editor__mode button')].find((b) => b.textContent === 'Live').click()`)
  await until(`!document.querySelector('.file-editor__rendered') && !document.querySelector('.file-editor__host').hidden && document.querySelector('.cm-content')?.textContent.includes('three')`, 'live again, with the change')
  await run(`window.superego.call('local', 'pane.open', { id: '${paned}', kind: 'artifact', params: { path: 'page.html' } })`)
  const artifactRan = async () => {
    for (let i = 0; i < 100; i++) {
      const frame = BrowserWindow.getAllWindows()[0].webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('superego-artifact:'))
      if (frame && await frame.executeJavaScript('document.body?.dataset.ok').catch(() => undefined) === 'yes') return
      await new Promise((r) => setTimeout(r, 100))
    }
    await fail('the artifact did not run'); throw new Error('failed')
  }
  await artifactRan()
  if (await run(`document.querySelectorAll('.panes__tab').length`) !== 3) { await fail('three pane tabs'); throw new Error('failed') }
  await shot('panes')
  // The room between two columns resizes the one on its left (as macOS does); the one on its right keeps its width.
  const widths = () => run(`JSON.stringify([...document.querySelectorAll('.panes > [data-column]')].map((c) => Math.round(c.getBoundingClientRect().width)))`).then(JSON.parse)
  const [threadBefore, firstBefore] = await widths()
  await run(`(() => {
    const gap = document.querySelector('.panes__gap')
    const x = gap.getBoundingClientRect().left + 4
    gap.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: 300 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 60, clientY: 300 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, clientY: 300 }))
  })()`)
  await until(`(() => { const w = [...document.querySelectorAll('.panes > [data-column]')].map((c) => Math.round(c.getBoundingClientRect().width)); return Math.abs(w[0] - ${threadBefore} - 60) <= 2 && Math.abs(w[1] - ${firstBefore}) <= 2 })()`, 'the gap resized the thread, not the pane')
  // Opened from outside the window (as the agent opens them), they open beside and the focus stays put. ⌘W closes the
  // one with the focus, from inside the page too: the window takes its shortcuts before a frame.
  if (await run(`Boolean(document.querySelector('.panes__tab.is-active'))`)) { await fail('a pane the window did not open took the focus'); throw new Error('failed') }
  // A hidden window's page never has focus, so focus never moves; emulate it (nothing reaches the screen).
  const emulated = BrowserWindow.getAllWindows()[0].webContents.debugger
  if (!emulated.isAttached()) emulated.attach()
  await emulated.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await run(`document.querySelector('.frame-pane iframe').focus()`)
  await until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('page.html')`, 'focus into the page brings it forward')
  for (let left = 2; left >= 0; left--) {
    await key('w')
    await until("document.querySelectorAll('.panes__tab').length === " + left, 'a pane closed, ' + left + ' left')
    // The focus moved left: closing page.html leaves notes.md, before it, with the focus.
    if (left === 2) await until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('notes.md') && Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'focus moved to the pane on the left')
  }
  await until(`!document.querySelector('.panes__tab')`, 'panes closed')
  // The header's pane menu opens one too.
  await run(`document.querySelector('.thread__panes').click()`)
  await until(`[...document.querySelectorAll('.superego-menu__item')].some((i) => i.textContent === 'Changes')`, 'pane menu offers Changes')
  await run(`[...document.querySelectorAll('.superego-menu__item')].find((i) => i.textContent === 'Changes').click()`)
  await until(`document.querySelector('.panes__tab')?.textContent.startsWith('Changes')`, 'pane menu opened Changes')
  await key('w')
  await until(`!document.querySelector('.panes__tab')`, 'menu pane closed')
  // ⌘P: a file by a few letters of its name, opened beside the thread; its tree shows it, and a click there shows
  // another file in the same editor.
  await key('p')
  await until(`Boolean(document.querySelector('.files-open .palette__input'))`, 'quick open')
  await run(`(() => {
    const input = document.querySelector('.files-open .palette__input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'note')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.files-open li.is-active')?.textContent.startsWith('notes.md')`, 'quick open finds notes.md')
  await key('Enter', [])
  await until(`document.querySelector('.panes__tab.is-active')?.textContent.startsWith('notes.md') && !document.querySelector('.files-tree')`, 'notes.md open, its tree closed')
  await key('t', ['meta', 'shift'])
  await until(`Boolean(document.querySelector('.files-tree__row.is-current'))`, 'tree shown, at notes.md')
  await run(`[...document.querySelectorAll('.files-tree__row')].find((b) => b.textContent === 'page.html').click()`)
  await until(`document.querySelectorAll('.panes__tab').length === 1 && document.querySelector('.panes__tab')?.textContent.startsWith('page.html')`, 'the tree showed page.html in the same editor')
  // Clicking a pane's title takes the focus into it: the editor's text.
  await run(`document.querySelector('.composer textarea').focus()`)
  await run(`document.querySelector('.panes__label').click()`)
  await until(`document.activeElement?.matches('.cm-content')`, "a pane's title click focuses its editor")
  // Code is coloured by its language, loaded for the file's name.
  await until(`(() => { const base = getComputedStyle(document.querySelector('.cm-content')).color; return [...document.querySelectorAll('.cm-content .cm-line span')].some((s) => s.textContent === 'body' && getComputedStyle(s).color !== base) })()`, 'html in the editor is highlighted')
  await shot('files')
  // The editor keeps its place: when focus comes back to it from the keyboard, and when its thread is shown again.
  await run(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'long.md', content: Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\\n') })`)
  const editorPane = await run(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${paned}').panes[0].id)`)
  await run(`window.superego.call('local', 'pane.update', { id: '${paned}', pane: '${editorPane}', params: { path: 'long.md' } })`)
  await until(`document.querySelector('.file-editor__scroll')?.scrollHeight > 3000`, 'a long file open')
  await run(`document.querySelector('.file-editor__scroll').scrollTop = 1500`)
  await new Promise((r) => setTimeout(r, 200))
  await run(`document.querySelector('.composer textarea').focus()`)
  await key('Right', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.cm-content')`, 'focus back in the editor')
  await new Promise((r) => setTimeout(r, 200))
  const kept = await run(`document.querySelector('.file-editor__scroll').scrollTop`)
  if (Math.abs(kept - 1500) > 4) { await fail(`the editor scrolled to ${kept} on focus`); throw new Error('failed') }
  // The app's keys work from inside the editor: it doesn't keep ⌘/ (comment) or ⌘L (select line) for itself.
  const docBefore = await run(`document.querySelector('.cm-content').textContent`)
  await key('/')
  await until(`!document.querySelector('.app__sidebar')`, 'cmd+/ from the editor hides the sidebar')
  await key('/')
  await until(`Boolean(document.querySelector('.app__sidebar'))`, 'and shows it')
  await run(`document.querySelector('.cm-content').focus()`)
  await key('l')
  await until(`Boolean(document.querySelector('.navigator'))`, 'cmd+L from the editor opens the navigator')
  await key('Escape', [])
  await until(`!document.querySelector('.navigator')`, 'navigator closed')
  if (await run(`document.querySelector('.cm-content').textContent`) !== docBefore) { await fail('the editor changed its text on app keys'); throw new Error('failed') }
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => !li.classList.contains('is-selected')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent !== 'panes'`, 'another thread')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('panes')).click()`)
  await until(`document.querySelector('.file-editor__scroll')?.scrollHeight > 3000`, 'the long file again')
  await until(`Math.abs(document.querySelector('.file-editor__scroll').scrollTop - 1500) <= 4`, 'the editor where it was left')
  // Changed on disk by someone else while open (another editor, git): the editor shows it at once, still in place.
  const { writeFileSync: writeOutside, renameSync } = await import('node:fs')
  writeOutside(`${repo}/.long.md.tmp`, Array.from({ length: 300 }, (_, i) => 'edited ' + i).join('\n'))
  renameSync(`${repo}/.long.md.tmp`, `${repo}/long.md`)
  await until(`document.querySelector('.cm-content')?.textContent.includes('edited ')`, 'the change shown')
  await until(`Boolean(document.querySelector('.cm-content .cm-arrived'))`, 'the change flashes as it arrives')
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/arrival.png`, (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG())
  await until(`!document.querySelector('.cm-content .cm-arrived')`, 'and fades')
  await until(`Math.abs(document.querySelector('.file-editor__scroll').scrollTop - 1500) <= 4`, 'still where it was')
  // ⌘W closes the pane with the focus: the editor's, here (switching back put it in the prompt).
  await run(`document.querySelector('[data-column]:not([data-column="thread"]) .cm-content').focus()`)
  await key('w')
  await until(`!document.querySelector('.panes__tab')`, 'editor closed')
  // The window as it was left, after a reload: the same thread selected, its unsent draft still there.
  await run(`document.querySelector('.composer textarea').focus()`)
  BrowserWindow.getAllWindows()[0].webContents.insertText('half a thought')
  await until(`document.querySelector('.composer textarea').value === 'half a thought'`, 'draft typed')
  BrowserWindow.getAllWindows()[0].webContents.reload()
  await until(`document.querySelector('.thread__title')?.textContent === 'panes' && document.querySelector('.composer textarea')?.value === 'half a thought'`, 'selection and draft kept across a reload')
  await run(`document.querySelector('.composer textarea').select()`)
  await key('Backspace', [])
  await until(`document.querySelector('.composer textarea').value === ''`, 'draft cleared')
  // ⌘/ hides the sidebar and shows it again; Threads in the rail stays where it was.
  const toggleAt = () => run(`JSON.stringify(document.querySelector('.threads-rail__button').getBoundingClientRect())`)
  const before = await toggleAt()
  await key('/')
  await until(`!document.querySelector('.app__sidebar')`, 'sidebar hidden')
  if (await toggleAt() !== before) { await fail('the sidebar button moved'); throw new Error('failed') }
  await key('/')
  await until(`Boolean(document.querySelector('.app__sidebar'))`, 'sidebar shown')
  // ⌃Tab: from where keyboard focus is (the prompt, in the thread), to each pane beside it, and around; ⌘W closes the
  // one it's in.
  await run(`window.superego.call('local', 'pane.open', { id: '${paned}', kind: 'diff' })`)
  await until(`Boolean(document.querySelector('.panes__tab'))`, 'a pane beside')
  await run(`document.querySelector('.composer textarea').focus()`)
  await key('Tab', ['control'])
  await until(`Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'ctrl+tab to the pane')
  await key('Tab', ['control'])
  await until(`Boolean(document.activeElement?.closest('[data-column="thread"]'))`, 'ctrl+tab around to the thread')
  await key('Tab', ['control'])
  await until(`Boolean(document.activeElement?.closest('[data-column]:not([data-column="thread"])'))`, 'and to the pane again')
  await key('w')
  await until(`!document.querySelector('.panes__tab')`, 'diff closed')
  // Sessions: the panes repository is one, the home folder another; ⌘⇧[ and ⌘⇧] go through every thread, across them.
  const { mkdirSync } = await import('node:fs')
  const elsewhere = `${process.env.SUPEREGO_HOME}/elsewhere`
  mkdirSync(elsewhere, { recursive: true })
  // With the window in the background, a thread finishing is a notification (headless, collected here, not shown).
  globalThis.superegoNotices = []
  await run(`window.dispatchEvent(new Event('blur'))`)
  const other = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(elsewhere)}, title: 'elsewhere', prompt: 'hi' }).then((t) => t.id)`)
  await until(`[...document.querySelectorAll('.threads-session__name')].some((n) => n.textContent.startsWith('elsewhere'))`, 'a session per project')
  // ⌘. : the next thread with something unread, here the new one once it has answered.
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('elsewhere') && li.querySelector('.superego-status--done'))`, 'other thread done, in the window')
  for (let i = 0; i < 50 && !globalThis.superegoNotices.some((n) => n.title === 'elsewhere' && n.body === 'Finished'); i++) await new Promise((r) => setTimeout(r, 100))
  if (!globalThis.superegoNotices.some((n) => n.title === 'elsewhere' && n.thread === other)) { await fail(`no notification of the thread finishing: ${JSON.stringify(globalThis.superegoNotices)}`); throw new Error('failed') }
  await run(`window.dispatchEvent(new Event('focus'))`)
  // Each press goes to the next unread one; looking at it marks it seen, so the presses reach the new one.
  for (let press = 0; press < 6 && await run(`document.querySelector('.thread__title')?.textContent`) !== 'elsewhere'; press++) {
    const was = await run(`document.querySelector('.thread__title')?.textContent`)
    await key('.')
    await until(`document.querySelector('.thread__title')?.textContent !== ${JSON.stringify(was)}`, 'cmd+. moved on')
    await new Promise((r) => setTimeout(r, 300))
  }
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'cmd+. reached the unread thread')
  await key(']', ['meta', 'shift'])
  await until(`document.querySelector('.thread__title')?.textContent !== 'elsewhere'`, 'cmd+shift+] to the next thread')
  const nextTitle = await run(`document.querySelector('.thread__title')?.textContent`)
  await key('[', ['meta', 'shift'])
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'cmd+shift+[ back')
  // ⌘[ and ⌘] : back and forward through the threads shown, as a browser goes; the buttons say where you can go.
  await until(`!document.querySelector('.app__back').disabled && document.querySelector('.app__forward').disabled`, 'back, not forward')
  // With the sidebar open they sit over the list, at its right edge, clear of the window's buttons.
  await until(`(() => { const back = document.querySelector('.app__back').getBoundingClientRect(), forward = document.querySelector('.app__forward').getBoundingClientRect(), list = document.querySelector('.app__sidebar').getBoundingClientRect(); return back.left >= 76 && Math.abs(list.right - 10 - forward.right) < 1 })()`, 'back and forward at the list\'s right edge')
  await key('[')
  await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(nextTitle)} && !document.querySelector('.app__forward').disabled`, 'cmd+[ back to the thread before')
  await key(']')
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere' && document.querySelector('.app__forward').disabled`, 'cmd+] forward again')
  await run(`document.querySelector('.app__back').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(nextTitle)}`, 'the back button')
  await run(`document.querySelector('.app__forward').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'the forward button')
  // ⌘⇧N: another window, on the same threads; closed again, so the rest goes on in the first.
  const firstWindow = BrowserWindow.getAllWindows()[0]
  await key('n', ['meta', 'shift'])
  for (let i = 0; i < 50 && BrowserWindow.getAllWindows().length < 2; i++) await new Promise((r) => setTimeout(r, 100))
  const newWindow = BrowserWindow.getAllWindows().find((w) => w !== firstWindow)
  if (!newWindow) { await fail('cmd+shift+n opened no window'); throw new Error('failed') }
  for (let i = 0; i < 100 && !(await newWindow.webContents.executeJavaScript(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100))
  if (!(await newWindow.webContents.executeJavaScript(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`).catch(() => false))) { await fail('the new window does not show the thread'); throw new Error('failed') }
  newWindow.destroy()
  // Archived: folded at the sidebar's end; opened, one list across projects.
  await run(`window.superego.call('local', 'thread.archive', { id: '${other}' })`)
  await until(`![...document.querySelectorAll('.threads-session .superego-list-item')].some((li) => li.querySelector('.superego-list-item__body')?.textContent.startsWith('elsewhere'))`, 'archived out of its session')
  await until(`document.querySelector('.threads-archived__head')?.getAttribute('aria-expanded') === 'false'`, 'archived folded')
  await run(`document.querySelector('.threads-archived__head').click()`)
  await until(`[...document.querySelectorAll('.threads-archived .superego-list-item')].some((li) => li.querySelector('.superego-list-item__body')?.textContent.startsWith('elsewhere'))`, 'archived listed')
  // Picked there, it shows read only: the prompt is off, and Unarchive is where Send would be; that brings it back.
  const isElsewhere = "(li) => li.querySelector('.superego-list-item__body')?.textContent.startsWith('elsewhere')"
  await run(`[...document.querySelectorAll('.threads-archived .superego-list-item')].find(${isElsewhere}).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere' && Boolean(document.querySelector('.titlebar__archived')) && document.querySelector('.composer textarea').disabled && Boolean(document.querySelector('.composer__unarchive'))`, 'archived thread shown read only')
  await until(`[...document.querySelectorAll('.threads-archived .superego-list-item')].some(${isElsewhere})`, 'and still archived')
  await run(`document.querySelector('.composer__unarchive').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere' && !document.querySelector('.titlebar__archived') && !document.querySelector('.composer textarea').disabled && [...document.querySelectorAll('.threads-session .superego-list-item')].some(${isElsewhere}) && ![...document.querySelectorAll('.threads-archived .superego-list-item')].some(${isElsewhere})`, 'unarchived and shown')
  await run(`document.querySelector('.threads-archived__head').click()`)
  // A thread another started sits right under it, though newer; ⌘⇧] and ⌘⇧[ go down and up the rows as shown, the
  // sidebar open or not.
  const offshoot = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(elsewhere)}, title: 'offshoot', parent: '${other}' }).then((t) => t.id)`)
  await until(`(() => { const rows = [...document.querySelectorAll('.threads-session .superego-list-item')], body = (li) => li?.querySelector('.superego-list-item__body')?.textContent ?? '', at = rows.findIndex((li) => body(li).startsWith('elsewhere')); return at >= 0 && body(rows[at + 1]).startsWith('offshoot') && rows[at + 1].classList.contains('threads-child') })()`, 'the offshoot under its parent')
  await key(']', ['meta', 'shift'])
  await until(`document.querySelector('.thread__title')?.textContent === 'offshoot'`, 'cmd+shift+] down to the offshoot')
  await key('/')
  await until(`!document.querySelector('.app__sidebar')`, 'sidebar hidden to step')
  await key('[', ['meta', 'shift'])
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'cmd+shift+[ up to its parent, the sidebar hidden')
  await key('/')
  await until(`Boolean(document.querySelector('.app__sidebar'))`, 'sidebar back after stepping')
  await run(`window.superego.call('local', 'thread.archive', { id: '${offshoot}' })`)
  await until(`![...document.querySelectorAll('.threads-session .superego-list-item')].some((li) => li.querySelector('.superego-list-item__body')?.textContent.startsWith('offshoot'))`, 'offshoot put away')
  // Superego's own agent: from the rail, one thread in Superego's data folder, the same one each time, in no list.
  const elsewhereItem = `[...document.querySelectorAll('.superego-list-item')].find((li) => li.querySelector('.superego-list-item__body')?.textContent.startsWith('elsewhere'))`
  await run(`document.querySelector('.ego__button').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ego' && document.querySelector('.ego__button').classList.contains('is-on') && !document.querySelector('.app__sidebar .superego-list-item.is-selected')`, 'Ego opened, not in the sidebar')
  const ego = await run(`window.superego.call('local', 'ego.ask', {}).then((t) => t.id)`)
  await run(`${elsewhereItem}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'away from it')
  await run(`document.querySelector('.ego__button').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ego'`, 'the same one again')
  if (await run(`window.superego.call('local', 'ego.ask', {}).then((t) => t.id)`) !== ego) { await fail('a second Ego'); throw new Error('failed') }
  if (await run(`window.superego.call('local', 'thread.list', {}).then((all) => all.some((t) => t.ext?.ego))`)) { await fail('Ego listed'); throw new Error('failed') }
  // Cleared from its title bar: the same thread, empty again.
  await run(`window.superego.call('local', 'thread.submit', { id: '${ego}', text: 'what is a profile?' })`)
  await until(`[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('what is a profile?'))`, 'asked Ego')
  // An outside agent's message shows as one; the user's doesn't.
  await run(`window.superego.call('local', 'action.run', { id: 'ego.ask', params: { prompt: 'and from an agent?' }, exposure: 'mcp' })`)
  await until(`[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('and from an agent?') && m.querySelector('.ego__outside') && !m.textContent.includes('<outside-agent>'))`, "an outside agent's message to Ego, marked")
  if (await run(`[...document.querySelectorAll('.msg--user')].find((m) => m.textContent.includes('what is a profile?')).querySelector('.ego__outside') !== null`)) { await fail("the user's message marked as an outside agent's"); throw new Error('failed') }
  await until(`(document.querySelector('.transcript')?.textContent.split('echo:').length ?? 0) > 2`, 'Ego answered both')
  await shot('ego-outside')
  await run(`document.querySelector('.ego__clear').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ego' && !document.querySelector('.msg--user')`, 'Ego cleared')
  await run(`${elsewhereItem}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'elsewhere'`, 'back to a listed thread')
  // Focus: ⌘⌥← from the prompt goes to the sidebar, on the selected thread; ↓ moves along it; ⌘⌥→ comes back to the
  // thread itself; ⌃I goes to the prompt from anywhere, and esc leaves it for the thread. Wherever it is, it's drawn.
  // A hidden window's page never has focus, so :focus styles never apply; emulate it (nothing reaches the screen).
  const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger
  if (!dbg.isAttached()) dbg.attach()
  await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await run(`document.querySelector('.composer textarea').focus()`)
  await key('Left', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.app__sidebar .superego-list-item.is-selected')`, 'focus to the sidebar, on the selected thread')
  const ring = await run(`getComputedStyle(document.activeElement).outlineStyle`)
  await key('Down', [])
  await until(`document.activeElement?.matches('.app__sidebar .superego-list-item:not(.is-selected)')`, 'down the sidebar')
  await shot('focus')
  await key('Right', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.thread__scroll')`, 'focus back to the thread')
  await key('Left', ['meta', 'alt'])
  await key('i', ['control'])
  await until(`document.activeElement?.matches('.composer textarea')`, 'ctrl+i to the prompt')
  await key('Escape', [])
  await until(`document.activeElement?.matches('.thread__scroll')`, 'esc from the prompt to the thread')
  await key('i', ['control'])
  await until(`document.activeElement?.matches('.composer textarea')`, 'ctrl+i back to the prompt')
  if (ring !== 'solid') { await fail(`focus not drawn: ${ring}`); throw new Error('failed') }
  // Every column draws the focus it holds, the same way: a page's (whose own focus the window can't see), from the
  // keyboard and from a click into it, and a pane with nothing in it to focus but itself.
  const another = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<body style="height:100vh">A page</body>') }).listen(0, '127.0.0.1')
  await new Promise((resolve) => another.once('listening', resolve))
  const shown = await run(`window.superego.call('local', 'thread.list', {}).then((all) => all.find((t) => t.title === 'elsewhere').id)`)
  // The column wearing the ring, and the one brought forward (its title lit): focus moving into a column brings it.
  const ringed = (label) => until(`(() => {
    const ringed = [...document.querySelectorAll('.panes > [data-column]')].filter((c) => getComputedStyle(c).borderTopColor !== 'rgba(0, 0, 0, 0)')
    return ringed.length === 1 && (ringed[0].querySelector('.panes__label')?.textContent ?? 'thread') === ${JSON.stringify(label)}
  })()`, `only ${label} ringed`)
  const front = (label) => until(`(document.querySelector('.panes__tab.is-active .panes__label')?.textContent ?? 'thread') === ${JSON.stringify(label)}`, `${label} brought forward`)
  await run(`window.superego.call('local', 'pane.open', { id: '${shown}', kind: 'preview', params: { url: 'http://127.0.0.1:${another.address().port}/' } })`)
  await until(`Boolean(document.querySelector('.frame-pane iframe'))`, 'a page beside the thread')
  await run(`document.querySelector('.composer textarea').focus()`)
  await ringed('thread')
  await key('Right', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.frame-pane iframe')`, 'cmd+alt+right into the page')
  await ringed('Preview')
  await front('Preview')
  // Out of it again: the page has the keyboard, so the window takes the key before it.
  await key('Left', ['meta', 'alt'])
  await until(`document.activeElement?.matches('.thread__scroll')`, 'cmd+alt+left out of the page')
  await ringed('thread')
  await front('thread')
  const click = async (selector) => {
    const box = JSON.parse(await run(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`))
    for (const type of ['mouseDown', 'mouseUp']) BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), button: 'left', clickCount: 1 })
  }
  await click('.frame-pane iframe')
  await until(`document.activeElement?.matches('.frame-pane iframe')`, 'a click into the page')
  await ringed('Preview')
  await front('Preview')
  await run(`window.superego.call('local', 'pane.close', { id: '${shown}', pane: document.querySelector('[data-column]:not([data-column="thread"])').dataset.column })`)
  another.close()
  // ⌘⇧D: Changes (git's), beside the thread, its tab in the strip.
  await key('D', ['meta', 'shift'])
  await until(`[...document.querySelectorAll('.strip__tab')].some((t) => t.textContent.startsWith('Changes'))`, 'cmd+shift+d: changes beside the thread')
  await run(`document.querySelector('.composer textarea').focus()`)
  await key('Right', ['meta', 'alt'])
  await until(`document.activeElement?.matches('[data-column]:not([data-column="thread"])')`, 'cmd+alt+right to the pane itself')
  await ringed('Changes')
  await run(`document.querySelector('.composer textarea').focus()`)
  await ringed('thread')
  // A click on its title, as on the rest of its own parts, takes the focus into it.
  await click('.panes__label')
  await until(`document.activeElement?.matches('[data-column]:not([data-column="thread"])')`, 'a click on the title, into the pane')
  await run(`window.superego.call('local', 'pane.close', { id: '${shown}', pane: document.activeElement.dataset.column })`)
  await until(`!document.querySelector('.panes__tab')`, 'changes closed')
  // ⌃`: a terminal beside the thread (terminal's), its shell on the machine, with the focus; typed into and read back.
  await key('`', ['control'])
  await until(`Boolean(document.querySelector('.terminal-pane__screen canvas')) && document.activeElement?.closest('.terminal-pane') !== null`, 'ctrl+`: a terminal with the focus')
  await ringed('Terminal')
  await until(`document.querySelector('.terminal-pane__screen').text().trim().length > 0`, 'the shell\'s prompt')
  await run(`(() => { const screen = document.querySelector('.terminal-pane__screen')
    for (const ch of 'echo "smoke-$((2*21))"\\n') screen.dispatchEvent(new KeyboardEvent('keydown', { key: ch === '\\n' ? 'Enter' : ch, code: ch === '\\n' ? 'Enter' : '', bubbles: true, cancelable: true })) })()`)
  await until(`document.querySelector('.terminal-pane__screen').text().includes('smoke-42')`, 'the shell\'s answer in the terminal')
  await run(`window.superego.call('local', 'pane.close', { id: '${shown}', pane: document.querySelector('[data-column]:not([data-column="thread"])').dataset.column })`)
  await until(`!document.querySelector('.panes__tab')`, 'terminal closed')
  // Attachments: a file picked with Attach (under the box) waits in the box, then goes with the message and shows under it.
  await run(`(() => {
    const input = document.querySelector('.dock__footer input[type=file]')
    const files = new DataTransfer()
    files.items.add(new File(['# plan\\n'], 'plan.md', { type: 'text/markdown' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`document.querySelector('.composer__files .attachment__name')?.textContent === 'plan.md'`, 'file waiting to be sent')
  await run(`document.querySelector('.composer textarea').focus()`)
  BrowserWindow.getAllWindows()[0].webContents.insertText('read this')
  await until(`document.querySelector('.composer textarea').value === 'read this'`, 'text typed')
  await key('Enter', [])
  await until(`[...document.querySelectorAll('.msg--user')].some((m) => m.textContent.includes('read this') && m.querySelector('.msg__files .attachment__name')?.textContent === 'plan.md') && !document.querySelector('.composer__files')`, 'file sent with the message')
  await shot('sessions')
  // Scrolling back: a thread longer than its watch holds pages in its earlier messages as the top comes near.
  const long = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(elsewhere)}, title: 'long' }).then((t) => t.id)`)
  for (let i = 0; i < 30; i++) {
    await run(`window.superego.call('local', 'thread.submit', { id: '${long}', text: 'message ${i}' })`)
    await until(`window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.id === '${long}').status.state === 'done')`, `long thread turn ${i}`)
  }
  await run(`window.superego.call('local', 'thread.seen', { id: '${long}' }).then(() => null)`)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('long')).click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'long' && document.querySelector('.transcript')?.textContent.includes('message 29')`, 'the long thread, at its end')
  if (await run(`document.querySelector('.transcript').textContent.includes('echo: message 0')`)) { await fail('the whole long thread came at once'); throw new Error('failed') }
  for (let i = 0; i < 20 && !(await run(`document.querySelector('.transcript').textContent.includes('echo: message 0')`)); i++) {
    await run(`(() => { const el = document.querySelector('[data-column="thread"] .thread__scroll'); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })()`)
    await new Promise((r) => setTimeout(r, 250))
  }
  await until(`document.querySelector('.transcript').textContent.includes('echo: message 0') && !document.querySelector('.transcript__more')`, 'scrolled back to the first message')
  // Scrolled up, the composer offers the way back down; taking it hides it again.
  await until(`Boolean(document.querySelector('[data-column="thread"] .dock__jump'))`, 'jump to bottom offered')
  await run(`document.querySelector('[data-column="thread"] .dock__jump').click()`)
  await until(`(() => { const el = document.querySelector('[data-column="thread"] .thread__scroll'); return el.scrollHeight - el.scrollTop - el.clientHeight < 40 && !document.querySelector('.dock__jump') })()`, 'jumped to the bottom')
  // Suggestions: numbered over the composer once the agent has answered (the echo model echoes them back from the
  // message). ⌃n sends the one with that number, from the thread as from the prompt; a number past them does nothing.
  const suggesting = await run(`window.superego.call('local', 'thread.create', { cwd: ${JSON.stringify(elsewhere)}, title: 'suggesting' }).then((t) => t.id)`)
  await run(`window.superego.call('local', 'thread.submit', { id: '${suggesting}', text: 'next? ["Run the tests", "Commit this"]' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('suggesting'))`, 'suggesting thread in the sidebar')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('suggesting')).click()`)
  await until(`[...document.querySelectorAll('.suggestions__item')].map((b) => b.textContent).join('|') === '${process.platform === 'darwin' ? '⌃1Run the tests|⌃2Commit this' : 'Ctrl+1Run the tests|Ctrl+2Commit this'}'`, 'suggestions with their keys')
  await run(`document.querySelector('[data-column="thread"] .thread__scroll').focus()`)
  const sent = `[...document.querySelectorAll('.msg--user')].map((m) => m.textContent)`
  await key('3', ['control'])
  await key('2', ['control'])
  await until(`${sent}.some((t) => t.includes('Commit this') && !t.includes('['))`, 'ctrl+2 sent the second suggestion')
  if (await run(`${sent}.length`) !== 2) { await fail(`ctrl+3 or ctrl+2 sent more: ${await run(`${sent}.join(' | ')`)}`); throw new Error('failed') }
  // Settings: the app's own sections, then the machine's, drawn from what each registers.
  await run(`document.querySelector('.app__settings').click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Appearance') && document.querySelector('.settings').textContent.includes('Notifications')`, 'app settings')
  await shot('settings')
  // Fonts: the picker lists installed families (FONTS here; needs a user gesture), and a choice sets the CSS variable.
  await run(`document.querySelector('[data-key="app.font.interface"] .superego-font-picker__button').click()`, true)
  await until(`document.querySelectorAll('.superego-font-picker__list button').length > 5`, 'installed fonts listed')
  await run(`[...document.querySelectorAll('.superego-font-picker__list button')].find((b) => b.textContent === 'Helvetica' || b.textContent === 'Arial').click()`)
  await until(`/Helvetica|Arial/.test(document.documentElement.style.getPropertyValue('--superego-font'))`, 'interface font applied')
  await run(`window.superego.call('app', 'app.settings.set', { key: 'app.font.mono', value: 'Menlo' })`)
  await until(`document.documentElement.style.getPropertyValue('--superego-mono').includes('Menlo')`, 'mono font applied')
  // The accent: shown as a swatch and its CSS, and applied as the colour everything accented takes.
  await until(`document.querySelector('[data-key="app.accent"] .color-field input:not([type=color])')?.value === 'color(display-p3 0.155 0.319 0.654)'`, 'accent colour shown')
  await setValue('[data-key="app.accent"] .color-field input:not([type=color])', 'oklch(0.6 0.2 30)')
  await run(`document.querySelector('[data-key="app.accent"] .color-field input:not([type=color])').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`)
  await until(`document.documentElement.style.getPropertyValue('--superego-accent-base') === 'oklch(0.6 0.2 30)'`, 'accent colour applied')
  await run(`[...document.querySelectorAll('[data-key="app.accent"] button')].find((b) => b.textContent === 'Reset').click()`)
  await until(`document.documentElement.style.getPropertyValue('--superego-accent-base').startsWith('color(display-p3')`, 'accent colour reset')
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
  if (await run(`Boolean(document.querySelector('.threads-rail'))`)) { await fail('the old shortcut still runs the action'); throw new Error('failed') }
  await key('R', ['meta', 'shift'])
  await until(`Boolean(document.querySelector('.threads-rail'))`, 'the new shortcut runs the action')
  await key('R', ['meta', 'shift'])
  await until(`!document.querySelector('.threads-rail')`, 'and back')
  await run(`window.superego.call('app', 'app.settings.set', { key: 'app.keys', value: { 'threads.rail': 'mod+shift+r', 'threads.details': 'mod+shift+r' } })`)
  await until(`document.querySelector('[data-action="threads.rail"] .keymap__clash')?.textContent.includes('Toggle thread details')`, 'clash shown')
  await run(`document.querySelector('.keymap').scrollIntoView()`)
  await shot('keyboard')
  await run(`[...document.querySelectorAll('.keymap__head button')].find((b) => b.textContent === 'Reset all').click()`)
  await until(`!document.querySelector('.keymap__clash') && ${keysOf('threads.rail')}?.textContent.includes('\\\\')`, 'reset to the actions’ own')
  // Machines: add one over ssh that can't connect; it shows its error, then goes away again.
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'Machines').click()`)
  await run(`window.superego.call('app', 'machines.add', { label: 'Nowhere', target: 'superego-smoke.invalid' })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('superego-smoke.invalid') && /disconnected/.test(row.textContent))`, 'ssh machine listed with its error')
  await run(`(async () => { const list = await window.superego.machines(); await window.superego.call('app', 'machines.remove', { id: list.find((m) => m.label === 'Nowhere').id }) })()`)
  await until(`![...document.querySelectorAll('.machine-row')].some((row) => row.textContent.includes('superego-smoke.invalid'))`, 'machine removed')
  // A second machine: another daemon, reached through a command that pipes stdio to it (as docker exec would).
  const second = `SUPEREGO_HOME='${process.env.SUPEREGO_HOME}/second' SUPEREGO_MODEL=faux node '${new URL('../bin/superego.ts', import.meta.url).pathname}' connect --start`
  await run(`window.superego.call('app', 'machines.add', { label: 'Second', via: ${JSON.stringify(second)} })`)
  await until(`[...document.querySelectorAll('.machine-row')].some((row) => row.querySelector('input')?.value === 'Second' && / · connected/.test(row.textContent))`, 'second machine connected', 30_000)
  await shot('machines')
  // All machines: a disagreement shows as Mixed, and one change reaches both.
  await run(`window.superego.call('local', 'settings.set', { key: 'agent.model', value: 'faux/faux-1' })`)
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'All machines').click()`)
  await until(`document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'mixed model across machines')
  await run(`(() => {
    const select = document.querySelector('[data-key="agent.model"] select')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'faux/faux-1')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`!document.querySelector('[data-key="agent.model"]')?.textContent.includes('Mixed')`, 'model set on all machines')
  const secondId = await run(`window.superego.machines().then((list) => list.find((m) => m.label === 'Second').id)`)
  const secondModel = await run(`window.superego.call('${secondId}', 'settings.watch', {}).then((r) => r.value.values['agent.model'])`)
  if (secondModel !== 'faux/faux-1') { await fail(`second machine model is ${secondModel}`); throw new Error('failed') }
  await until(`window.superego.machines().then((list) => list.filter((m) => m.state === 'connected').length === 2)`, 'both machines connected')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await until(`document.querySelector('.settings')?.textContent.includes('Providers') && Boolean(document.querySelector('[data-key="agent.model"]'))`, 'machine settings')
  await shot('providers')
  const hasFaux = await run(`[...document.querySelectorAll('[data-key="agent.model"] option')].some((o) => o.value === 'faux/faux-1')`)
  if (!hasFaux) { await fail('model choices'); throw new Error('failed') }
  // The menu bar: on by default; "Hide Dock icon" needs it; turning it off takes the item away.
  const desktop = () => run(`window.superego.call('app', 'app.desktop', {})`)
  if (!(await desktop()).menuBar) { await fail('menu bar item not up by default'); throw new Error('failed') }
  await run(`window.superego.call('app', 'app.settings.set', { key: 'app.hideDock', value: true })`)
  if (process.platform === 'darwin' && !(await desktop()).dockHidden) { await fail('dock not hidden'); throw new Error('failed') }
  await run(`window.superego.call('app', 'app.settings.set', { key: 'app.menuBar', value: false })`)
  await until(`window.superego.call('app', 'app.desktop', {}).then((d) => !d.menuBar && !d.dockHidden)`, 'menu bar off, dock back')
  const refused = await run(`window.superego.call('app', 'app.settings.set', { key: 'app.hideDock', value: true }).then(() => 'set', (e) => e.message)`)
  if (process.platform === 'darwin' && !/menu bar/.test(refused)) { await fail(`hide dock without menu bar: ${refused}`); throw new Error('failed') }
  await run(`window.superego.call('app', 'app.settings.set', { key: 'app.menuBar', value: true })`)
  // Restart: new daemon code on disk (faked with an extra file in the build) shows "Restart required"; restarting
  // brings up a daemon of that build, with the threads still there.
  await restartOntoNewCode(() => writeFileSync(STRAY, '// smoke\n'))
  // The dialog: Escape in the font picker closes only the picker; the next Escape closes Settings.
  const escape = async () => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'General').click()`)
  await until(`Boolean(document.querySelector('[data-key="app.font.mono"]'))`, 'general pane')
  await run(`document.querySelector('[data-key="app.font.mono"] .superego-font-picker__button').click()`, true)
  await until(`document.activeElement?.placeholder === 'Search fonts'`, 'picker focused')
  await escape()
  await until(`!document.querySelector('.superego-font-picker__popover') && Boolean(document.querySelector('.superego-dialog.settings'))`, 'picker closed, dialog open')
  await escape()
  await until(`!document.querySelector('.superego-dialog.settings')`, 'dialog closed by Escape')
  // Web access: the daemon serves the same window to a browser, to devices paired from Settings → Web access.
  const port = 20000 + Math.floor(Math.random() * 20000)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.port', value: ${port} })`)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'local' })`)
  await run(`document.querySelector('.app__settings').click()`)
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.includes('This computer')).click()`)
  await until(`[...document.querySelectorAll('.web-access button')].some((b) => b.textContent === 'Pair a device')`, 'Pair a device')
  await run(`[...document.querySelectorAll('.web-access button')].find((b) => b.textContent === 'Pair a device').click()`)
  await until(`Boolean(document.querySelector('.web-pair__qr svg'))`, 'a pairing link and its QR code')
  await run(`document.querySelector('.web-access').scrollIntoView({ block: 'center' })`)
  await shot('web-pair')
  const url = await run(`document.querySelector('.web-pair__link').textContent`)
  if (!new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=`).test(url)) { await fail(`pairing link ${url}`); throw new Error('failed') }
  const main = BrowserWindow.getAllWindows()[0]
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await browser.loadURL(url)
  const inBrowser = async (js, label) => {
    for (let i = 0; i < 150; i++) { if (await browser.webContents.executeJavaScript(js).catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)) }
    await fail(`web: waiting for ${label}`); throw new Error('failed')
  }
  await inBrowser(`window.superego.web === true && location.href === 'http://127.0.0.1:${port}/'`, 'web bridge, the ticket out of the address bar')
  // Paired: the device is listed, and the ticket is spent. (The browser is a window too: the app's is the one before it.)
  const inDesktop = async (js, label) => {
    for (let i = 0; i < 150; i++) { if (await main.webContents.executeJavaScript(js).catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)) }
    await fail(`web: waiting for ${label}`); throw new Error('failed')
  }
  await inDesktop(`!document.querySelector('.web-pair') && document.querySelectorAll('.web-device').length === 1`, 'the paired device listed')
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/web-devices.png`, (await main.webContents.capturePage()).toPNG())
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await inDesktop(`!document.querySelector('.superego-dialog.settings')`, 'Settings closed')
  await inBrowser(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'threads in the browser')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await inBrowser(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'a transcript in the browser')
  // A phone: one column, the threads in a drawer from the bar at the top.
  browser.setContentSize(390, 844)
  await inBrowser(`Boolean(document.querySelector('.app__mobilebar')) && !document.querySelector('.app__sidebar')`, 'phone layout')
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/phone-thread.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`document.querySelector('.app__mobilebar button').click()`)
  await inBrowser(`Boolean(document.querySelector('.app.has-drawer .app__sidebar'))`, 'drawer open')
  await new Promise((r) => setTimeout(r, 300))
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/phone-drawer.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await inBrowser(`!document.querySelector('.app__sidebar')`, 'drawer closes on picking a thread')
  // A thread finishing while another is shown: Unread, beside Settings in the drawer, has it, and goes there.
  await browser.webContents.executeJavaScript(`window.superego.call('local', 'thread.create', { title: 'unread on the phone', prompt: 'finish while away' })`)
  await browser.webContents.executeJavaScript(`document.querySelector('.app__mobilebar button').click()`)
  await inBrowser(`Boolean(document.querySelector('.app__footer .unread-button'))`, 'Unread beside Settings on a phone')
  await inBrowser(`Boolean(document.querySelector('.app__footer .ego__button'))`, 'Ego beside Settings on a phone')
  await browser.webContents.executeJavaScript(`document.querySelector('.app__footer .unread-button').click()`)
  await inBrowser(`[...document.querySelectorAll('.unread-menu .superego-menu__item')].some((i) => i.textContent.includes('unread on the phone'))`, 'the finished thread in Unread')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.unread-menu .superego-menu__item')].find((i) => i.textContent.includes('unread on the phone')).click()`)
  await inBrowser(`document.querySelector('.app__mobilebar')?.textContent.includes('unread on the phone') && !document.querySelector('.app__sidebar')`, 'Unread went to the thread')
  // A data view on a phone: the skills, placed as a space, switched to from the drawer's foot and drawn from data.
  await browser.webContents.executeJavaScript(`window.superego.call('app', 'app.settings.set', { key: 'app.layout', value: { place: { 'skills.view': 'space' } } })`)
  await browser.webContents.executeJavaScript(`document.querySelector('.app__mobilebar button').click()`)
  await inBrowser(`Boolean(document.querySelector('.app__drawer-bar [aria-label="Skills"]'))`, 'Skills among the spaces in the drawer')
  await browser.webContents.executeJavaScript(`document.querySelector('.app__drawer-bar [aria-label="Skills"]').click()`)
  await inBrowser(`document.querySelector('.data-view--space')?.textContent.includes('$smoke-skill') && document.querySelector('.data-view--space')?.textContent.includes('Checks the smoke.')`, 'the skills data view in the drawer')
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/phone-data-view.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`document.querySelector('.app__drawer-bar [aria-label="Threads"]').click()`)
  await inBrowser(`Boolean(document.querySelector('.app__sidebar .superego-list-item'))`, 'back to the threads in the drawer')
  // Ego from the drawer: its thread shown, and its Clear in the thread's sheet (the title bar's, on a phone).
  await browser.webContents.executeJavaScript(`document.querySelector('.app__footer .ego__button').click()`)
  await inBrowser(`!document.querySelector('.app__sidebar') && Boolean(document.querySelector('button.app__mobiletitle'))`, "Ego's thread shown on a phone")
  await browser.webContents.executeJavaScript(`document.querySelector('button.app__mobiletitle').click()`)
  await inBrowser(`Boolean(document.querySelector('.thread-sheet .ego__clear')) && !document.querySelector('.thread-sheet .thread__archive')`, "Ego's Clear in the thread's sheet")
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/phone-ego-sheet.png`, (await browser.webContents.capturePage()).toPNG())
  // The model button there shows the details (the aside's) in the sheet.
  await browser.webContents.executeJavaScript(`document.querySelector('.thread-sheet .threads-model').click()`)
  await inBrowser(`Boolean(document.querySelector('.thread-sheet .threads-details'))`, 'thread details in the sheet')
  await browser.webContents.executeJavaScript(`document.querySelector('.thread-sheet .threads-model').click()`)
  await browser.webContents.executeJavaScript(`document.querySelector('.app__scrim--sheet').click()`)
  await inBrowser(`!document.querySelector('.thread-sheet')`, 'the sheet closed')
  // No space and no picker on a phone: the bar stays, with the thread's sheet and Settings, and Settings has the layout
  // to edit (in a browser, in a dialog) back to the defaults.
  await browser.webContents.executeJavaScript(`window.superego.call('app', 'app.settings.set', { key: 'app.layout', value: { place: { 'threads.list': null, 'core.picker': null } } })`)
  await inBrowser(`Boolean(document.querySelector('.app__mobilebar .app__settings')) && Boolean(document.querySelector('.app__mobilebar button.app__mobiletitle')) && !document.querySelector('.app__mobilebar [aria-label="Threads"]')`, 'a phone with no space keeps its bar and Settings')
  await browser.webContents.executeJavaScript(`document.querySelector('.app__mobilebar .app__settings').click()`)
  await inBrowser(`Boolean(document.querySelector('.settings__nav button'))`, 'Settings on a phone')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'General').click()`)
  await inBrowser(`[...document.querySelectorAll('.setting[data-key="app.layout"] button')].some((b) => b.textContent === 'Edit layout…')`, 'the layout in Settings')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.setting[data-key="app.layout"] button')].find((b) => b.textContent === 'Edit layout…').click()`)
  await inBrowser(`Boolean(document.querySelector('.layout-editor__text')) && !document.querySelector('.settings')`, "the browser's layout in a dialog")
  await browser.webContents.executeJavaScript(`(() => {
    const text = document.querySelector('.layout-editor__text')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(text, '{ "place": { "threads.list": "sidebar" } }')
    text.dispatchEvent(new Event('input', { bubbles: true }))
    ;[...document.querySelectorAll('.layout-editor button')].find((b) => b.textContent === 'Save').click()
  })()`)
  await inBrowser(`document.querySelector('.layout-editor .layout-note.is-problem')?.textContent.includes('No place "sidebar"')`, 'a layout that does not read, noted')
  await browser.webContents.executeJavaScript(`(() => {
    const text = document.querySelector('.layout-editor__text')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(text, '{}')
    text.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.layout-editor button')].find((b) => b.textContent === 'Save').click()`)
  await inBrowser(`!document.querySelector('.layout-editor') && Boolean(document.querySelector('.app__mobilebar [aria-label="Threads"]'))`, 'the layout back from the dialog')
  await browser.webContents.executeJavaScript(`window.superego.call('app', 'app.settings.set', { key: 'app.layout', value: {} })`)
  // Images over the WebSocket, on a phone: the thread's images load, and the lightbox fills the screen.
  await browser.webContents.executeJavaScript(`document.querySelector('.app__mobilebar button').click()`)
  await inBrowser(`Boolean(document.querySelector('.app.has-drawer .app__sidebar'))`, 'drawer open again')
  await browser.webContents.executeJavaScript(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('show me the screens')).click()`)
  await inBrowser(`Boolean(document.querySelector('.images--single .images__frame.is-ready') && document.querySelector('.images--carousel .images__frame.is-ready'))`, 'images read over the web')
  await browser.webContents.executeJavaScript(`document.querySelector('.images--carousel').scrollIntoView({ block: 'center' })`)
  await new Promise((r) => setTimeout(r, 300))
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/phone-images.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`document.querySelector('.images--single .images__frame').click()`)
  await inBrowser(`document.querySelector('.lightbox .lightbox__image.is-ready') && document.querySelector('.lightbox').getBoundingClientRect().width === innerWidth`, 'lightbox on a phone')
  await new Promise((r) => setTimeout(r, 300))
  if (process.env.SUPEREGO_SMOKE_SHOTS) writeFileSync(`${process.env.SUPEREGO_SMOKE_SHOTS}/phone-lightbox.png`, (await browser.webContents.capturePage()).toPNG())
  await browser.webContents.executeJavaScript(`document.querySelector('.lightbox__bar button[aria-label="Close"]').click()`)
  await inBrowser(`!document.querySelector('.lightbox')`, 'lightbox closed on a phone')
  // An artifact over the web, by the device's cookie: the page, and a file it links to (from its sandbox's own origin).
  await main.webContents.executeJavaScript(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'pic.html', content: '<img src="dot.svg" onload="parent.postMessage(\\'loaded\\', \\'*\\')" onerror="parent.postMessage(\\'failed\\', \\'*\\')">' })`)
  await main.webContents.executeJavaScript(`window.superego.call('local', 'file.write', { id: '${paned}', path: 'dot.svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' })`)
  const artifact = await browser.webContents.executeJavaScript(`new Promise((resolve) => {
    addEventListener('message', (event) => resolve(event.data), { once: true })
    const frame = document.createElement('iframe')
    frame.sandbox = 'allow-scripts'
    frame.src = window.superego.artifactUrl('local', '${paned}', 'pic.html')
    document.body.append(frame)
    setTimeout(() => resolve('timed out'), 5000)
  })`)
  if (artifact !== 'loaded') { await fail(`an artifact's file over the web: ${artifact}`); throw new Error('failed') }
  // Another origin's WebSocket is refused, cookie or not (localhost is this computer, but not this page's origin).
  const crossSite = await browser.webContents.executeJavaScript(`new Promise((resolve) => { const ws = new WebSocket('ws://localhost:' + location.port + '/rpc'); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('refused') })`)
  if (crossSite !== 'refused') { await fail(`a WebSocket from another origin got in: ${crossSite}`); throw new Error('failed') }
  // A page on the home screen keeps its own cookies: a browser of its own. The link again is spent; it asks for a code.
  browser.setContentSize(1100, 760)
  const phone = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: 'smoke-phone' } })
  const inPhone = async (js, label) => {
    for (let i = 0; i < 150; i++) { if (await phone.webContents.executeJavaScript(js).catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)) }
    await fail(`web: waiting for ${label}`); throw new Error('failed')
  }
  await phone.loadURL(url)
  await inPhone(`document.activeElement?.classList.contains('pair-gate__input') && document.querySelector('.pair-gate__error')?.textContent.includes('used already') && location.hash === ''`, 'a spent link refused, the code form focused')
  const submitCode = (value) => phone.webContents.executeJavaScript(`(() => { document.querySelector('.pair-gate__input').value = ${JSON.stringify(value)}; document.querySelector('.pair-gate').requestSubmit() })()`)
  await submitCode('AAAA-AAAA')
  await inPhone(`document.querySelector('.pair-gate__error')?.textContent.includes('isn’t right')`, 'a wrong code refused')
  const { code } = await main.webContents.executeJavaScript(`window.superego.call('local', 'web.pair', {})`)
  await submitCode(code.toLowerCase())
  await inPhone(`!document.querySelector('.pair-gate')`, 'the code form gone')
  await inPhone(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'threads after typing the code')
  // Revoked: its connection closes at once, and it asks to be paired again; the other browser stays.
  const devices = await main.webContents.executeJavaScript(`window.superego.call('local', 'web.devices', {})`)
  if (devices.length !== 2) { await fail(`devices: ${JSON.stringify(devices)}`); throw new Error('failed') }
  const newest = devices.reduce((a, b) => a.created > b.created ? a : b)
  await main.webContents.executeJavaScript(`window.superego.call('local', 'web.revoke', { id: ${JSON.stringify(newest.id)} })`)
  await inPhone(`Boolean(document.querySelector('.pair-gate'))`, 'a revoked device asked to pair again')
  await inBrowser(`!document.querySelector('.pair-gate') && [...document.querySelectorAll('.superego-list-item')].length > 0`, 'the other device still in')
  phone.destroy()
  browser.destroy()
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'off' })`)
  // The second machine's profile UI: the thread works without it, and the window asks; it runs once allowed here, stops
  // when its sources change, and is taken out when revoked, with a reload offered.
  const onSecond = await run(`window.superego.call('${secondId}', 'thread.create', { title: '' }).then((t) => t.id)`)
  await run(`window.superego.call('${secondId}', 'thread.submit', { id: '${onSecond}', text: 'over on second' })`)
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('over on second'))`, 'the remote thread in the sidebar', 30_000)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('over on second')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: over on second')`, 'the remote thread works')
  await until(`document.querySelector('.profile-ui-notice')?.textContent.includes('Second’s profile default has UI code')`, 'asked to allow the remote profile UI')
  if (await run(`Boolean(document.querySelector('.remote-badge'))`)) { await fail('remote profile UI ran before it was allowed'); throw new Error('failed') }
  await run(`[...document.querySelectorAll('.profile-ui-notice button')].find((b) => /files?,/.test(b.textContent)).click()`)
  await until(`document.querySelector('.profile-ui-notice__files')?.textContent.includes('ui/label.ts')`, 'its files listed')
  await new Promise((resolve) => setTimeout(resolve, 300))
  await shot('profile-ui-notice')
  await run(`[...document.querySelectorAll('.profile-ui-notice__file')].find((b) => b.textContent === 'ui/label.ts').click()`)
  await until(`document.querySelector('.profile-source')?.textContent.includes("remote ui")`, 'its source shown, read-only, in a pane')
  await run(`[...document.querySelectorAll('.profile-ui-notice button')].find((b) => b.textContent === 'Allow').click()`)
  await until(`document.querySelector('.remote-badge')?.textContent === 'remote ui' && !document.querySelector('.profile-ui-notice')`, 'the remote profile UI runs once allowed')
  // Changed there: it stops, and the window asks again.
  writeFileSync(`${process.env.SUPEREGO_HOME}/second/profiles/default/ui/label.ts`, "export const label: string = 'changed ui'\n")
  await run(`window.superego.call('${secondId}', 'thread.submit', { id: '${onSecond}', text: 'after the change' })`)
  await until(`!document.querySelector('.remote-badge') && Boolean(document.querySelector('.profile-ui-notice'))`, 'a changed profile UI stops until allowed again')
  // Not now: remembered on this computer for these sources, and the header says so quietly; a click asks again.
  await run(`[...document.querySelectorAll('.profile-ui-notice button')].find((b) => b.textContent === 'Not now').click()`)
  await until(`!document.querySelector('.profile-ui-notice') && document.querySelector('.profile-ui-marker')?.textContent === 'UI not allowed'`, 'put off: a marker in the header')
  if (!readFileSync(`${process.env.SUPEREGO_HOME}/ui-declined.json`, 'utf8').includes('"default"')) { await fail('"Not now" not kept in ui-declined.json'); throw new Error('failed') }
  await new Promise((resolve) => setTimeout(resolve, 300))
  await shot('profile-ui-declined')
  await run(`document.querySelector('.profile-ui-marker').click()`)
  await until(`Boolean(document.querySelector('.profile-ui-notice')) && !document.querySelector('.profile-ui-marker')`, 'the marker asks again')
  await run(`[...document.querySelectorAll('.profile-ui-notice button')].find((b) => b.textContent === 'Allow').click()`)
  await until(`document.querySelector('.remote-badge')?.textContent === 'changed ui'`, 'the changed UI runs once allowed')
  // Settings lists it under its machine; Revoke takes it out.
  await run(`document.querySelector('.app__settings').click()`)
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent === 'Machines').click()`)
  await until(`document.querySelector('.machine-row__ui')?.textContent.includes('default')`, 'allowed profile UI listed in Settings')
  await shot('profile-ui-settings')
  await run(`[...document.querySelectorAll('.machine-row__ui button')].find((b) => b.textContent === 'Revoke').click()`)
  await until(`!document.querySelector('.machine-row__ui') && !document.querySelector('.remote-badge')`, 'revoked: the remote profile UI stops')
  // Its code ran here: a reload is offered, to stop anything it left going.
  await until(`document.querySelector('.machine-row__revoked')?.textContent.includes('Reload the window')`, 'revoked: a reload offered in Settings')
  await escape()
  await until(`!document.querySelector('.superego-dialog.settings')`, 'settings closed')
  await until(`Boolean(document.querySelector('.profile-ui-notice')) && !document.querySelector('.profile-ui-marker')`, 'revoked: asked again')
  await until(`[...document.querySelectorAll('.revoked-ui-notice button')].some((b) => b.textContent === 'Reload')`, 'revoked: a reload offered in the window')
  await run(`[...document.querySelectorAll('.revoked-ui-notice button')].find((b) => b.textContent === 'Later').click()`)
  await until(`!document.querySelector('.revoked-ui-notice')`, 'revoked: the reload put off')
  // Ego on each machine: its title bar says whose, and switches to another's; the rail opens the one last chosen.
  const pickEgo = (machine) => run(`(() => {
    const select = document.querySelector('.ego__machine')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(machine)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await run(`document.querySelector('.ego__button').click()`)
  await until(`document.querySelector('.thread__title')?.textContent === 'Ego' && document.querySelector('.ego__machine')?.value === 'local' && document.querySelectorAll('.ego__machine option').length === 2`, 'Ego, with a machine switch')
  await shot('ego-machines')
  await pickEgo(secondId)
  await until(`document.querySelector('.ego__machine')?.value === '${secondId}' && document.querySelector('.thread__title')?.textContent === 'Ego' && document.querySelector('.ego__button').classList.contains('is-on')`, "the second machine's Ego")
  if (await run(`window.superego.call('${secondId}', 'thread.list', {}).then((all) => all.some((t) => t.ext?.ego))`)) { await fail('Ego listed on the second machine'); throw new Error('failed') }
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('over on second')).click()`)
  await until(`!document.querySelector('.ego__machine') && !document.querySelector('.ego__button').classList.contains('is-on')`, 'away from Ego')
  await run(`document.querySelector('.ego__button').click()`)
  await until(`document.querySelector('.ego__machine')?.value === '${secondId}'`, 'the rail opens the Ego last chosen')
  await pickEgo('local')
  await until(`document.querySelector('.ego__machine')?.value === 'local'`, "back to this computer's Ego")
  console.log('smoke(first): ok')
} else {
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('hello from smoke'))`, 'thread after reopen')
  await until(`window.superego.machines().then((list) => list.filter((m) => m.state === 'connected').length === 2)`, 'second machine reconnected after reopen', 30_000)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('hello from smoke')).click()`)
  await until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'transcript after reopen')
  // The second machine's provider rejects its key (the scripted model does, for a key starting "reject"): the threads it
  // stops wait quietly, one notice names the machine and counts them, one notification says it (not one per thread),
  // Sign in again opens that machine's Providers, and a new key takes them on by themselves.
  const secondId = await run(`window.superego.machines().then((list) => list.find((m) => m.label === 'Second').id)`)
  const secondAuth = `${process.env.SUPEREGO_HOME}/second/auth.json`
  writeFileSync(secondAuth, JSON.stringify({ faux: { type: 'api_key', key: 'reject-me' } }))
  globalThis.superegoNotices = []
  await run(`window.dispatchEvent(new Event('blur'))`)
  for (const prompt of ['keyed one', 'keyed two']) await run(`window.superego.call('${secondId}', 'thread.create', { title: '${prompt}', prompt: '${prompt}' })`)
  await until(`document.querySelector('.auth-notice')?.textContent.startsWith('faux rejected the API key on Second.2 threads are waiting.')`, 'one notice for the rejected key, naming the machine')
  await until(`[...document.querySelectorAll('.superego-list-item')].filter((li) => /keyed (one|two)/.test(li.textContent) && li.querySelector('.superego-status--signin')).length === 2`, 'the threads waiting quietly')
  await new Promise((r) => setTimeout(r, 500))
  const keyNotices = globalThis.superegoNotices.filter((n) => n.machine === secondId)
  if (keyNotices.length !== 1 || keyNotices[0].title !== 'faux rejected the API key') { await fail(`not one notification for the rejected key: ${JSON.stringify(globalThis.superegoNotices)}`); throw new Error('failed') }
  await run(`window.dispatchEvent(new Event('focus'))`)
  // Shown, a waiting thread says why in place of its failure, and offers to sign in again.
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('keyed one')).click()`)
  await until(`document.querySelector('.transcript__waiting')?.textContent.startsWith('faux rejected the API key. It goes on once you sign in again.') && !document.querySelector('.transcript__error')`, 'the thread waiting, not failed')
  await run(`document.querySelector('.auth-notice').scrollIntoView()`)
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme
    await new Promise((r) => setTimeout(r, 400))
    await shot(`auth-notice-${theme}`)
  }
  nativeTheme.themeSource = 'system'
  await run(`[...document.querySelectorAll('.auth-notice button')].find((b) => b.textContent === 'Sign in again').click()`)
  await until(`document.querySelector('.settings__nav-machine.is-selected')?.textContent.includes('Second') && document.querySelector('.settings')?.textContent.includes('Providers')`, "sign in again: that machine's Providers")
  await run(`document.querySelector('.superego-dialog__actions button[aria-label="Close"]').click()`)
  writeFileSync(secondAuth, JSON.stringify({}))
  // The one shown is seen as it answers; the other is done.
  await until(`!document.querySelector('.auth-notice') && !document.querySelector('.transcript__waiting') && document.querySelector('.transcript')?.textContent.includes('echo: keyed one')
    && [...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('keyed two') && li.querySelector('.superego-status--done'))`, 'a new key: the threads went on and answered', 20_000)
  // `superego <dir> -p ...` from a terminal: a new thread there, shown in this (already running) app.
  const { execFileSync } = await import('node:child_process')
  const cli = new URL('../bin/superego.ts', import.meta.url).pathname
  execFileSync('node', [cli, process.env.SUPEREGO_HOME, '-p', 'from the cli'], { env: { ...process.env, SUPEREGO_APP: new URL('..', import.meta.url).pathname } })
  await until(`document.querySelector('.thread__title')?.textContent === 'from the cli' && document.querySelector('.transcript')?.textContent.includes('echo: from the cli')`, 'thread opened from the command line', 30_000)
  // The extra file is gone again: the daemon is out of date once more, and restarts back.
  await restartOntoNewCode(() => rmSync(STRAY, { force: true }))
  // App settings persisted in the app's own file.
  await until(`document.documentElement.style.getPropertyValue('--superego-mono').includes('Menlo')`, 'font after reopen')
  console.log('smoke(reopen): ok')
}
// Passed: smoke.sh stops the app if it hangs on its way out (see run-app.sh).
clearTimeout(deadline)
writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
app.exit(0)
})().catch((error) => { if (error.message !== 'failed') void fail(error.stack ?? String(error)) })

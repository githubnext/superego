// What opening a thread with very large pasted screenshots costs (run by `test/look.sh <dir> big-images`): three
// messages each with a screenshot of a whole page (2560×12000 and two of 1700×8000, as pasted in a real thread), then
// the window reloaded and the thread opened afresh. Printed, and kept in $SUPEREGO_SHOWCASE_OUT/big-images.json: the
// bytes the transcript and its images bring over the link, how long until it's drawn with the images in view, how long
// the page's main thread was blocked meanwhile, the pixels decoded, and the window's memory, then again after
// scrolling through the whole thread. It's opened twice, the second time as it is once its images have been shown. `SUPEREGO_BIG_IMAGES` names a folder of PNGs to paste instead of drawn ones.
import { app, nativeImage } from 'electron'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

process.env.SUPEREGO_MODEL = 'faux'

/** A page's screenshot, as PNG: rows of "text" on bands of colour, noisy enough to weigh what a real one does. */
function screenshot(width, height, seed) {
  const pixels = Buffer.alloc(width * height * 4, 255)
  let r = seed
  const rand = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff }
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 600) % 3
    const line = y % 24 < 14 && rand() > 0.1
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const ink = line && x > 80 && x < width - 80 && rand() > 0.55
      const shade = ink ? 30 + Math.floor(rand() * 60) : [250, 242, 232][band]
      pixels[at] = shade; pixels[at + 1] = shade - (band === 1 ? 6 : 0); pixels[at + 2] = shade - (band === 2 ? 12 : 0)
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG()
}

const dir = process.env.SUPEREGO_BIG_IMAGES
const shots = dir
  ? readdirSync(dir).filter((name) => name.endsWith('.png')).sort().map((name) => ({ name, bytes: readFileSync(join(dir, name)) }))
  : [[2560, 12000], [1707, 8000], [1703, 7980]].map(([w, h], i) => ({ name: `page-${i + 1}.png`, bytes: screenshot(w, h, i + 1) }))

const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 10) / 10

/** The window's processes' memory, in MB: its page's (the renderer) and the GPU's, which holds what's drawn. */
function memory() {
  const metrics = app.getAppMetrics()
  const of = (type) => metrics.filter((m) => m.type === type).reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024
  return { renderer: Math.round(of('Tab')), gpu: Math.round(of('GPU')) }
}

/** In the page: the images the transcript shows, and the pixels decoded for them. */
const IMAGES = `(() => {
  const drawn = [...document.querySelectorAll('.thread__scroll img')].filter((img) => img.complete && img.naturalWidth)
  return { drawn: drawn.length, pixels: drawn.reduce((sum, img) => sum + img.naturalWidth * img.naturalHeight, 0) }
})()`

await openApp({ name: 'big-images', timeout: 300_000, size: [1100, 900] }, async (t) => {
  await t.call('thread.start', { title: 'Elsewhere' })
  const { id } = await t.call('thread.start', { title: 'Big screenshots' })
  const send = async (text, shot) => {
    const before = await t.call('thread.list', {}).then((list) => list.find((x) => x.id === id)?.activeAt)
    await t.call('thread.send', { thread: id, text, ...(shot ? { attachments: [{ name: shot.name, mimeType: 'image/png', data: shot.bytes.toString('base64') }] } : {}) })
    await t.until(`window.superego.call('local', 'thread.list', {}).then((list) => { const x = list.find((t) => t.id === '${id}'); return x?.status.state !== 'working' && x?.activeAt !== ${before ?? 0} })`, `the answer to "${text}"`, 60_000)
  }
  await send('This page is broken, see', shots[0])
  for (let n = 1; n <= 6; n++) await send(`More about it, ${n}: ${'words '.repeat(60)}`)
  await send('And this one', shots[1])
  await send('And this', shots[2])
  await send('What now?')

  const pick = (title) => t.run(`[...document.querySelectorAll('.superego-list-item')].find((e) => e.textContent.includes(${JSON.stringify(title)})).click()`)
  /** The window reloaded (nothing of the thread in it), then the thread opened: how long until it's drawn, its images in view too. */
  const open = async () => {
    await pick('Elsewhere')
    await t.until(`!document.querySelector('.thread__scroll .msg--user')`, 'the other thread open')
    t.contents().reload()
    await t.until(`window.superego?.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'connected again', 60_000)
    await t.until(`Boolean(document.querySelector('.superego-list-item'))`, 'the thread listed')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const idle = memory()
    await t.run(`window.__blocked = 0; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__blocked += e.duration }).observe({ type: 'longtask', buffered: false })`)
    const started = Date.now()
    await pick('Big screenshots')
    await t.until(`Boolean(document.querySelector('.thread__scroll .msg--user'))`, 'the transcript')
    const transcript = Date.now() - started
    await t.until(`(() => {
      const scroll = document.querySelector('.thread__scroll').getBoundingClientRect()
      const shown = [...document.querySelectorAll('.thread__scroll img')].filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > scroll.top && r.top < scroll.bottom })
      return shown.length > 0 && shown.every((img) => img.complete && img.naturalWidth > 0)
    })()`, 'the images in view drawn', 120_000)
    await t.run(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
    return { idle, transcript, painted: Date.now() - started, blocked: Math.round(await t.run('window.__blocked')) }
  }
  // Twice: the second time, the images' thumbnails are made already.
  const first = await open()
  const { idle, transcript, painted, blocked } = await open()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const opened = { ...memory(), images: await t.run(IMAGES) }

  // Through the whole thread, top to bottom, so every image is drawn.
  await t.run(`(async () => {
    const scroll = document.querySelector('.thread__scroll')
    for (let y = 0; y <= scroll.scrollHeight; y += scroll.clientHeight / 2) { scroll.scrollTop = y; await new Promise((r) => setTimeout(r, 150)) }
    scroll.scrollTop = 0; await new Promise((r) => setTimeout(r, 300)); scroll.scrollTop = scroll.scrollHeight
  })()`)
  await t.until(`[...document.querySelectorAll('.thread__scroll img')].every((img) => img.complete)`, 'every image drawn', 120_000)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const scrolled = { ...memory(), images: await t.run(IMAGES) }

  // What the transcript itself weighs over the link, as a watch of it answers; and each image's, as the window reads
  // it (`image.read`, a thumbnail, where there's one: its pixels are in the transcript where there isn't). The thread
  // opens at its end: the images drawn then are its newest.
  const { sub, value } = await t.call('thread.watch', { thread: id })
  await t.call('unwatch', { sub })
  const transcriptBytes = JSON.stringify(value).length
  const stubs = value.entries.flatMap((entry) => [entry.model?.[0]?.content].flat().filter(Boolean).flatMap((block, index) => block.type === 'image' && !block.data ? [{ entry: entry.id, message: 0, block: index }] : []))
  const read = []
  for (const image of stubs) read.push((await t.call('image.read', { thread: id, image, thumbnail: true })).data.length)
  const sum = (list) => list.reduce((a, b) => a + b, 0)

  // How it looks: the newest screenshot's top in the transcript, then whole in the lightbox.
  await t.both('big-images', `document.querySelector('.thread__scroll').scrollTop = 1e9`)
  await t.run(`[...document.querySelectorAll('.thread__scroll .image-frame')].at(-1).click()`)
  await t.until(`Boolean(document.querySelector('.lightbox .lightbox__image.is-ready')) && !document.querySelector('.lightbox__loading')`, 'the screenshot whole in the lightbox', 60_000)
  await t.both('big-images-lightbox')

  const result = {
    images: shots.map((s) => `${s.name}: ${mb(s.bytes.length)} MB`),
    transcriptMB: mb(transcriptBytes),
    imagesInViewMB: mb(sum(read.slice(read.length - opened.images.drawn))),
    allImagesMB: mb(sum(read)),
    transcriptShownMs: { first: first.transcript, again: transcript },
    imagesInViewDrawnMs: { first: first.painted, again: painted },
    mainThreadBlockedMs: { first: first.blocked, again: blocked },
    pixelsDecodedInView: `${Math.round(opened.images.pixels / 1e6)} Mpx (${mb(opened.images.pixels * 4)} MB as RGBA)`,
    pixelsDecodedAll: `${Math.round(scrolled.images.pixels / 1e6)} Mpx (${mb(scrolled.images.pixels * 4)} MB as RGBA)`,
    memoryMB: { idle, opened: { renderer: opened.renderer, gpu: opened.gpu }, scrolled: { renderer: scrolled.renderer, gpu: scrolled.gpu } },
  }
  console.log(JSON.stringify(result, null, 2))
  if (process.env.SUPEREGO_SHOWCASE_OUT) writeFileSync(join(process.env.SUPEREGO_SHOWCASE_OUT, 'big-images.json'), JSON.stringify(result, null, 2))
})

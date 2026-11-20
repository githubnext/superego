// Screenshots of images in a thread (run by `test/look.sh <dir> images`): an agent's shown images (one alone, a grid
// with one gone, a carousel), the lightbox (zoomed, a very tall image and a very wide one), its answer's own images
// inline and in the lightbox; an image file open in the editor pane; then a phone's width. Light and dark, into $SUPEREGO_SHOWCASE_OUT.
import { nativeImage } from 'electron'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { openApp } from './harness.mjs'
import { fitted, picture } from './smoke/common.mjs'

// Its own recorded agent, in place of the showcase's, set before the daemon starts and reads it.
const home = process.env.SUPEREGO_HOME
const S = `${home}/shots`
const turns = `${home}/images-turns.jsonl`
const turn = (content) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' } })
const show = (id, args) => ({ type: 'toolCall', id, name: 'show_images', arguments: args })
writeFileSync(turns, [
  turn([
    show('img-1', { images: [{ path: `${S}/wide.png`, caption: 'The home page, at full width' }] }),
    show('img-2', { title: 'Before and after', images: [{ path: `${S}/a.png`, caption: 'Before' }, { path: `${S}/b.png`, caption: 'After' }, { path: `${S}/gone.png`, caption: 'Gone' }] }),
    show('img-3', { images: [1, 2, 3, 4, 5, 6].map((n) => ({ path: `${S}/${n}.png`, ...(n % 3 === 1 ? {} : { caption: `Number ${n}` }) })) }),
    show('img-4', { images: [{ path: `${S}/tall.png`, caption: 'A tall one' }] }),
    show('img-5', { images: [{ path: `${S}/panorama.png` }] }),
  ]),
  turn([{ type: 'text', text: `Those are the screens.\n\n![The wide one](wide.png)\n\n![Before](file:${S}/a.png) and ![Before, by its whole path](${S}/a.png)\n\n![Elsewhere](/etc/elsewhere.png)` }]),
].join('\n') + '\n')
process.env.SUPEREGO_MODEL = `replay:${turns}`

await openApp({ name: 'images', timeout: 180_000, size: [1100, 760] }, async (t) => {
  const { run, until } = t
  mkdirSync(S, { recursive: true })
  const draw = (name, width, height, hue) => writeFileSync(`${S}/${name}.png`, picture(nativeImage, width, height, hue))
  draw('wide', 1280, 720, 40); draw('tall', 400, 3000, 160); draw('panorama', 3000, 400, 90)
  draw('a', 640, 480, 200); draw('b', 640, 480, 120); draw('gone', 480, 640, 10)
  for (const n of [1, 2, 3, 4, 5, 6]) draw(String(n), 900 - n * 40, 600, n * 37)
  const { id } = await t.call('thread.start', { cwd: S, title: 'The screens' })
  await t.call('thread.send', { thread: id, text: 'show me the screens' })
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}')?.status.state === 'done')`, 'the images shown', 30_000)
  const shown = `${home}/attachments/${id}/shown`
  rmSync(`${shown}/${readdirSync(shown).find((name) => name.endsWith('-gone.png'))}`)
  await t.call('thread.seen', { thread: id })
  await t.click('.superego-list-item')
  const ready = (selector) => `(() => { document.querySelector('${selector}')?.scrollIntoView({ block: 'center' }); return Boolean(document.querySelector('${selector} .images__frame.is-ready, ${selector} .images__frame.is-broken')) })()`
  for (const selector of ['.images--single', '.images--grid', '.images--carousel']) await until(ready(selector), selector)
  await t.both('images', `document.querySelector('.images--single').scrollIntoView({ block: 'start' })`)
  await t.both('images-grid', `document.querySelector('.images--grid').scrollIntoView({ block: 'start' })`)
  // The lightbox: the grid's first; zoomed in.
  const press = (key) => run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`)
  await run(`document.querySelector('.images--grid .images__frame').focus(); document.querySelector('.images--grid .images__frame').click()`)
  await until(`Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'the lightbox')
  await t.both('lightbox')
  await t.click('.lightbox__bar button[aria-label="Zoom in"]')
  await until(`Boolean(document.querySelector('.lightbox__stage.is-zoomed'))`, 'zoomed')
  await t.both('lightbox-zoomed')
  await press('Escape')
  await until(`!document.querySelector('.lightbox')`, 'the lightbox closed')
  // A very tall image and a very wide one, each whole.
  for (const [nth, name] of [[1, 'tall'], [2, 'wide']]) {
    await run(`(() => { const f = document.querySelectorAll('.images--single')[${nth}]; f.scrollIntoView({ block: 'center' }); f.querySelector('.images__frame').click() })()`)
    await until(fitted, `the ${name} one, fitted`)
    await t.both(`lightbox-${name}`)
    await press('Escape')
    await until(`!document.querySelector('.lightbox')`, `the ${name} one closed`)
  }
  // The answer's own images, inline, then in the lightbox.
  const inline = `[...document.querySelectorAll('.msg__text .image-frame--inline')]`
  await until(`(() => { const m = ${inline}; m.at(-1)?.scrollIntoView({ block: 'center' }); return m.length === 4 && m.slice(0, 3).every((f) => f.classList.contains('is-ready')) })()`, 'the inline images')
  await t.both('message-images', `${inline}[3].scrollIntoView({ block: 'center' })`)
  await run(`${inline}[0].click()`)
  await until(`Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'an inline image in the lightbox')
  await t.both('message-images-lightbox')
  await press('Escape')
  await until(`!document.querySelector('.lightbox')`, 'the lightbox closed')
  // An image file in the editor pane: the picture, fitted, its size in the bar.
  await t.call('pane.open', { thread: id, kind: 'editor', params: { path: `${S}/wide.png` } })
  await until(`(() => { const img = document.querySelector('.image-file__img'); return Boolean(img?.complete && img.naturalWidth) && document.querySelector('.image-file .pane-bar__note')?.textContent === '1280 × 720' })()`, 'the image file in the editor pane')
  await t.both('image-file')
  await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}').panes.find((p) => p.kind === 'editor')).then((pane) => window.superego.call('local', 'pane.close', { thread: '${id}', pane: pane.id }))`)
  await until(`!document.querySelector('.image-file')`, 'the editor pane closed')
  // A phone's width (the window goes no narrower than 600: zoomed, its page is a phone's 375).
  await t.resize(600, 760)
  await t.zoom(1.6)
  await until(ready('.images--carousel'), 'the carousel on a phone')
  await t.both('phone-images')
  await run(`(() => { const f = document.querySelector('.images--single'); f.scrollIntoView({ block: 'center' }); f.querySelector('.images__frame').click() })()`)
  await until(`Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'the lightbox on a phone')
  await t.both('phone-lightbox')
  await t.click('.lightbox__bar button[aria-label="Close"]')
  await until(`!document.querySelector('.lightbox')`, 'the lightbox closed on a phone')
  await run(`(() => { const f = document.querySelectorAll('.images--single')[1]; f.scrollIntoView({ block: 'center' }); f.querySelector('.images__frame').click() })()`)
  await until(fitted, 'the tall one, fitted on a phone')
  await t.both('phone-lightbox-tall')
})

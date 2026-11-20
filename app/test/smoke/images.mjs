// Images a replayed agent shows (show_images), drawn in the thread: one alone, a grid, a carousel; a file gone by then
// shows as broken; any opens in the lightbox, which zooms, goes through the set, and closes on Escape. Then its answer's
// own images, inline. (What they look like: `look.sh <dir> images`.)
import { nativeImage } from 'electron'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fitted, home, openRow, picture } from './common.mjs'

export default async function images(t, s) {
  const shots = `${home}/shots`
  mkdirSync(shots, { recursive: true })
  const draw = (name, width, height, hue) => writeFileSync(`${shots}/${name}.png`, picture(nativeImage, width, height, hue))
  draw('wide', 1280, 720, 40)
  draw('tall', 400, 3000, 160); draw('panorama', 3000, 400, 90)
  draw('a', 640, 480, 200); draw('b', 640, 480, 120); draw('gone', 480, 640, 10)
  for (const n of [1, 2, 3, 4, 5, 6]) draw(String(n), 900 - n * 40, 600, n * 37)
  s.showing = (await t.call('thread.start', { cwd: shots })).id
  await t.call('thread.send', { thread: s.showing, text: 'show me the screens' })
  await t.until(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${s.showing}')?.status.state === 'done')`, 'images shown by the agent')
  // One shown file gone from the machine before anyone looks: that one is broken, the rest still show.
  const shownDir = `${home}/attachments/${s.showing}/shown`
  rmSync(`${shownDir}/${readdirSync(shownDir).find((name) => name.endsWith('-gone.png'))}`)
  await openRow(t, 'show me the screens')
  // Opened, it lands at its end, and stays there as what's in it is laid out.
  await t.until(`(() => { const s = document.querySelector('.thread__scroll'); return Boolean(document.querySelector('.images--carousel')) && s.scrollHeight - s.scrollTop - s.clientHeight < 2 })()`, 'the thread opened at its end')
  // Each is read as it nears the screen: the first, above, once scrolled to (and kept in view while it loads).
  await t.until(`(() => { document.querySelector('.images--single')?.scrollIntoView({ block: 'center' }); return document.querySelector('.images--single .images__frame.is-ready') && document.querySelector('.images--single .images__caption')?.textContent === 'The home page, at full width' })()`, 'a single image, loaded, with its caption')
  await t.until(`document.querySelectorAll('.images--grid .images__frame').length === 3 && document.querySelectorAll('.images--grid .images__frame.is-ready').length === 2 && document.querySelector('.images--grid .images__frame.is-broken')?.textContent.includes('Image not found')`, 'a grid, with the gone one broken')
  await t.until(`document.querySelector('.images--grid .images__title')?.textContent === 'Before and after'`, 'the grid titled')
  await t.until(`document.querySelector('.images--carousel .images__count')?.textContent === '1 / 6' && Boolean(document.querySelector('.images--carousel .images__slide .images__frame.is-ready'))`, 'a carousel at its first')
  // Not folded away with the run's steps: the images are in the thread as it reads.
  await t.check(`!document.querySelector('details:not([open]) .images')`, 'images folded into the run')
  await t.click('.images--carousel .images__nav--next')
  await t.until(`document.querySelector('.images--carousel .images__count')?.textContent === '2 / 6' && document.querySelector('.images--carousel .images__caption')?.textContent === 'Second'`, 'carousel moved on by its button')
  await t.run(`(() => { const c = document.querySelector('.images__carousel'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })()`)
  await t.until(`document.querySelector('.images--carousel .images__count')?.textContent === '3 / 6'`, 'carousel moved on by →')
  await t.until(`(() => { const t = document.querySelector('.images__track'); return Math.abs(t.scrollLeft - 2 * t.clientWidth) < 1 })()`, 'carousel settled on the third', 5000)

  // The lightbox: the grid's first, then → to the next; zoom in and out; Escape closes it and the focus goes back.
  const press = (key) => t.run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`)
  await t.run(`document.querySelector('.images--grid .images__frame').focus(); document.querySelector('.images--grid .images__frame').click()`)
  await t.until(`document.querySelector('.lightbox .lightbox__image.is-ready') && document.querySelector('.lightbox__caption')?.textContent === 'Before' && document.activeElement === document.querySelector('.lightbox')`, 'lightbox open, focused')
  await press('ArrowRight')
  await t.until(`document.querySelector('.lightbox__caption')?.textContent === 'After' && document.querySelector('.lightbox__count')?.textContent === '2 / 3' && Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'lightbox → next image')
  await t.click('.lightbox__bar button[aria-label="Zoom in"]')
  await t.until(`Boolean(document.querySelector('.lightbox__stage.is-zoomed')) && document.querySelector('.lightbox__image').style.transform.includes('scale(2.5)')`, 'lightbox zoomed')
  await press('0')
  await t.until(`!document.querySelector('.lightbox__stage.is-zoomed')`, 'lightbox back to fit')
  await press('ArrowRight')
  await t.until(`document.querySelector('.lightbox__broken')?.textContent.includes('gone.png')`, 'the gone one, broken in the lightbox too')
  await press('Escape')
  await t.until(`!document.querySelector('.lightbox') && document.activeElement === document.querySelector('.images--grid .images__frame')`, 'lightbox closed by Escape, focus back')
  // A very tall image and a very wide one each fit the window whole, both ways (`fitted`).
  for (const [nth, name] of [[1, 'tall'], [2, 'wide']]) {
    await t.run(`(() => { const f = document.querySelectorAll('.images--single')[${nth}]; f.scrollIntoView({ block: 'center' }); f.querySelector('.images__frame').click() })()`)
    await t.until(fitted, `a ${name} image, whole, fitted`)
    if (name === 'tall') {
      // A right-click on the enlarged image is Chromium's to answer, as an image: what the native menu offers Copy
      // Image and Save Image As… for. The app's own handler is set aside meanwhile, so no menu opens.
      const contents = t.contents()
      const handlers = contents.listeners('context-menu')
      contents.removeAllListeners('context-menu')
      let params
      contents.once('context-menu', (_event, p) => { params = p })
      await t.mouse('.lightbox__image', { button: 'right' })
      await t.until(() => params, 'the image menu asked for', 5000)
      contents.removeAllListeners('context-menu')
      for (const handler of handlers) contents.on('context-menu', handler)
      if (params.mediaType !== 'image' || !params.srcURL) t.fail(`no image menu on the lightbox's image: ${params.mediaType}`)
      await t.check(`Boolean(document.querySelector('.lightbox:not(:has(.is-zoomed))'))`, 'a right-click zoomed or closed the lightbox')
    }
    await press('Escape')
    await t.until(`!document.querySelector('.lightbox')`, `the ${name} one closed`)
  }

  // Its answer's own images, inline: read from the thread's folder (by a relative path, file:// or a whole one), fitted
  // to the column; one that isn't there (outside the folder: read all the same) is broken, quietly, saying why. Any opens in the same lightbox, through the
  // message's images.
  const inline = `[...document.querySelectorAll('.msg__text .image-frame--inline')]`
  await t.until(`(() => { const m = ${inline}; m[0]?.scrollIntoView({ block: 'center' }); return m.length === 4 })()`, 'inline images in the answer')
  await t.until(`${inline}.slice(0, 3).every((f) => f.classList.contains('is-ready') && f.querySelector('img').src.startsWith('blob:'))`, 'inline images read from the thread’s folder')
  await t.until(`(() => { const f = ${inline}[3]; return f.classList.contains('is-broken') && f.textContent === 'Elsewhere' && f.title.includes('not found') })()`, 'a missing image outside the folder, saying so')
  await t.check(`${inline}.every((f) => f.getBoundingClientRect().right <= f.closest('.msg').getBoundingClientRect().right + 0.5)`, 'inline images overflow the message')
  await t.run(`${inline}[0].click()`)
  // Keys are the dialog's once the focus is in it, a frame after it opens (Base UI moves it on the next frame).
  await t.until(`document.querySelector('.lightbox .lightbox__image.is-ready') && document.querySelector('.lightbox__count')?.textContent === '1 / 4' && document.activeElement === document.querySelector('.lightbox')`, 'an inline image in the lightbox, focused')
  await press('ArrowRight')
  await t.until(`document.querySelector('.lightbox__count')?.textContent === '2 / 4' && Boolean(document.querySelector('.lightbox .lightbox__image.is-ready'))`, 'lightbox → the message’s next image')
  await press('Escape')
  await t.until(`!document.querySelector('.lightbox')`, 'inline lightbox closed by Escape')
  // A file rewritten after it showed: the window coming back to the front checks it, and the message shows the new one.
  const unchanged = await t.run(`${inline}[0].querySelector('img').src`)
  draw('wide', 1200, 720, 200)
  await t.run(`window.dispatchEvent(new Event('focus'))`)
  await t.until(`(() => { const f = ${inline}[0], img = f.querySelector('img'); return img.src !== ${JSON.stringify(unchanged)} && f.classList.contains('is-ready') && img.naturalWidth === 1200 })()`, 'a rewritten image swapped in')
  await t.call('settings.set', { key: 'agent.model', value: 'faux/faux-1' })
}

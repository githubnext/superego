// What smoke's areas share: the sidebar's rows, the rail's notices, a pane's web page, and a restart onto new code.
import { webContents } from 'electron'

export const home = process.env.SUPEREGO_HOME

/** The page in a pane's web view (a Browser pane's: a web page's, an artifact's) whose address starts with `prefix`. */
export const pageAt = (prefix) => webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().startsWith(prefix))

/** A click into a pane's web page, at `x`, `y` in it. A hidden window's view never has the system's focus: the click's, as it comes. */
export function clickInto(t, page, { x = 200, y = 200 } = {}) {
  for (const type of ['mouseDown', 'mouseUp']) page.sendInputEvent({ type, button: 'left', clickCount: 1, x, y })
  if (!t.win().isVisible()) page.emit('focus')
}
/** An extra file in the build: the daemon's code on disk changed, as an update would change it. */
export const STRAY = new URL('../../out/main/zz-smoke-restart.js', import.meta.url).pathname

/** The sidebar's row whose text has `text` (an expression). */
export const row = (text) => `[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(text)}))`

/** Show the thread whose row has `text`, once it's listed. */
export async function openRow(t, text) {
  await t.until(`Boolean(${row(text)})`, `"${text}" in the sidebar`)
  await t.run(`${row(text)}.click()`)
}

/** Over the rail, the notice of `kind` (rail-notice.tsx), opened: all it says, in its popover. */
export async function openNotice(t, kind, label) {
  await t.until(`Boolean(document.querySelector('.app__rail .rail-notice--${kind}'))`, `${label} in the rail`)
  if (!await t.run(`Boolean(document.querySelector('.rail-notice__popup'))`)) await t.click(`.app__rail .rail-notice--${kind}`)
  await t.until(`Boolean(document.querySelector('.rail-notice__popup'))`, `${label} opened`)
}

/**
 * New daemon code on disk (`change` makes it) shows "Restart required"; restarting brings up a daemon of that build, with
 * the threads still there. `atRest`: before restarting, with the window at rest on Threads, hide the sidebar: the notice
 * stays in the rail.
 */
export async function restartOntoNewCode(t, change, { atRest = false } = {}) {
  const before = await t.run(`window.superego.machines().then((list) => list.find((m) => m.id === 'local'))`)
  change()
  await t.until(`document.querySelector('.app__rail .rail-notice--service')?.getAttribute('aria-label') === 'Restart required'`, 'restart required shown in the rail')
  if (atRest) {
    // The sidebar hides with the notice up (it lived in the sidebar's foot, and held it open): the threads go to dots,
    // the notice stays in the rail.
    t.key('/')
    await t.until(`!document.querySelector('.app__sidebar') && Boolean(document.querySelector('.threads-rail .threads-rail__dot')) && Boolean(document.querySelector('.app__rail .rail-notice--service'))`, 'hidden with the restart notice up')
  }
  await openNotice(t, 'service', 'restart required')
  await t.until(`document.querySelector('.rail-notice__popup .service-notice')?.textContent.includes('Restart required')`, 'restart required, in full')
  await t.click('.rail-notice__popup .service-notice button', 'Restart now')
  await t.until(`!document.querySelector('.rail-notice--service') && !document.querySelector('.rail-notice__popup')`, 'restart done', 40_000)
  if (atRest) {
    t.key('/')
    await t.until(`Boolean(document.querySelector('.app__sidebar .threads-project'))`, 'the list again after the restart')
  }
  const after = await t.run(`window.superego.call('local', 'hello', { client: 'smoke', version: 2 })`)
  if (after.machine.id !== before.machine.id || !(await t.call('thread.list')).length) t.fail('restart lost the machine or its threads')
  return after
}

/** The lightbox's image whole, to scale: inside the stage's padding and above the caption, never larger than it is. */
export const fitted = `(() => {
  const img = document.querySelector('.lightbox .lightbox__image.is-ready'), stage = document.querySelector('.lightbox__stage')
  if (!img || !img.complete) return false
  const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect(), cs = getComputedStyle(stage), caption = document.querySelector('.lightbox__caption')?.getBoundingClientRect()
  const inside = r.top >= s.top + parseFloat(cs.paddingTop) - 1 && r.bottom <= s.bottom - parseFloat(cs.paddingBottom) + 1 && r.left >= s.left + parseFloat(cs.paddingLeft) - 1 && r.right <= s.right - parseFloat(cs.paddingRight) + 1
  const shaped = Math.abs(r.width / r.height - img.naturalWidth / img.naturalHeight) < 0.02 && r.width <= img.naturalWidth && r.height <= img.naturalHeight
  return inside && shaped && r.bottom <= innerHeight && r.right <= innerWidth && (!caption || r.bottom <= caption.top) && r.width > 20 && r.height > 20
})()`

/** A picture, as PNG: a gradient with a grid over it, so zooming and panning show. */
export function picture(nativeImage, width, height, hue) {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const line = x % 80 < 2 || y % 80 < 2
    const [r, g, b] = [hue, (hue + 90) % 256, (hue + 170) % 256].map((c, i) => Math.round(c * (0.55 + 0.45 * (i === 0 ? x / width : y / height))))
    pixels.set(line ? [250, 250, 250, 255] : [b, g, r, 255], (y * width + x) * 4)
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG()
}

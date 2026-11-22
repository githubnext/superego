// The window's height as what's visible of it: on a phone, above the on-screen keyboard. iOS doesn't shrink the page for
// the keyboard; it slides the page up under the status bar instead, by however far it judges the focused field needs,
// and the fixed bar at the top goes with it. Sized to what's visible (`--superego-viewport-height`, on the root, read
// by styles.css and app.css), the page fits above the keyboard with its composer at the foot, and it's kept at the top.
// While the keyboard is up (`:root[data-keyboard]`), the page's foot is the keyboard's top, not the screen's edge: no
// room is kept there for the home indicator (app.css).
// iOS reveals a field it focuses by sliding the page, not the box the field scrolls in: that box may not scroll yet,
// with the keyboard still down. Put back at the top and shrunk, the page can hide the field under its box's new foot
// (a dialog's prompt), so once it has shrunk the box scrolls to bring the field back into sight.

/** Taller than any bar a browser shows or hides as it scrolls: a window this much shorter than it was has a keyboard over it. */
const KEYBOARD = 120

/** Follows the visible part of the window into `--superego-viewport-height`, and keeps the page scrolled to its top. */
export function followViewport() {
  const viewport = window.visualViewport
  if (!viewport) return
  const root = document.documentElement
  // The tallest the window has been at its width: turned, or resized, it starts again.
  let width = 0
  let tallest = 0
  let last = 0
  const follow = () => {
    // Pinched in (a desktop browser), what's visible is smaller but the window isn't: scale it back up.
    const height = Math.round(viewport.height * viewport.scale)
    if (window.innerWidth !== width) { width = window.innerWidth; tallest = 0 }
    tallest = Math.max(tallest, height)
    root.style.setProperty('--superego-viewport-height', `${height}px`)
    root.toggleAttribute('data-keyboard', tallest - height > KEYBOARD)
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
    if (height < last && document.activeElement instanceof HTMLElement) reveal(document.activeElement)
    last = height
  }
  viewport.addEventListener('resize', follow)
  viewport.addEventListener('scroll', follow)
  follow()
}

/** Scrolls the nearest box that scrolls around `field` (if any) just far enough to show it, its top first if it's taller. */
function reveal(field: HTMLElement) {
  for (let box = field.parentElement; box && box !== document.body; box = box.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(box).overflowY)) continue
    const inside = field.getBoundingClientRect()
    const around = box.getBoundingClientRect()
    if (inside.top < around.top) box.scrollTop -= around.top - inside.top
    else if (inside.bottom > around.bottom) box.scrollTop += Math.min(inside.bottom - around.bottom, inside.top - around.top)
    return
  }
}

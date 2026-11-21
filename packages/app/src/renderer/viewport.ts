// The window's height as what's visible of it: on a phone, above the on-screen keyboard. iOS doesn't shrink the page for
// the keyboard; it slides the page up under the status bar instead, by however far it judges the focused field needs,
// and the fixed bar at the top goes with it. Sized to what's visible (`--superego-viewport-height`, on the root, read
// by styles.css and app.css), the page fits above the keyboard with its composer at the foot, and it's kept at the top.
// While the keyboard is up (`:root[data-keyboard]`), the page's foot is the keyboard's top, not the screen's edge: no
// room is kept there for the home indicator (app.css).

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
  const follow = () => {
    // Pinched in (a desktop browser), what's visible is smaller but the window isn't: scale it back up.
    const height = Math.round(viewport.height * viewport.scale)
    if (window.innerWidth !== width) { width = window.innerWidth; tallest = 0 }
    tallest = Math.max(tallest, height)
    root.style.setProperty('--superego-viewport-height', `${height}px`)
    root.toggleAttribute('data-keyboard', tallest - height > KEYBOARD)
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
  }
  viewport.addEventListener('resize', follow)
  viewport.addEventListener('scroll', follow)
  follow()
}

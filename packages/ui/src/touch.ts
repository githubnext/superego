import { useSyncExternalStore, type RefObject } from 'react'

/*
 * Touch, hover and the phone: three questions, each asked one way everywhere.
 *
 * - **No hover** (`@media (hover: none)`): nothing points without pressing, so what a mouse would reveal by pointing at
 *   it (a row's chevron, a copy button, a menu trigger) shows all the time. Stylesheets only. Per event, for something
 *   that appears as a pointer enters it, `hovering(event)`: a tap enters too, but doesn't hover.
 * - **Finger-sized** (`@media (pointer: coarse)`): the device's main pointer is a finger, so targets get room to be hit
 *   and fields are at least 16px (or iOS zooms into them). Stylesheets only: it says what the device is, not what's in
 *   use, and an iPad with a keyboard and trackpad still says coarse.
 * - **Under a finger** (`underFinger()`, and `:root[data-finger]` for stylesheets): the last thing the user did was a
 *   tap. Then a field doesn't take the focus by itself (`autoFocusOnOpen()`, `popupFocus()`), as that brings up the
 *   on-screen keyboard over what just opened, and the focused region wears no ring (what was tapped is where you are).
 *   A mouse, a trackpad or a key only a hardware keyboard sends (a shortcut, Tab, Escape, the arrows) ends it, so an
 *   iPad with a keyboard keeps its keyboard affordances; until the first of them, it's `pointer: coarse`. To follow it
 *   as it changes (a key's hint shown only while there's a keyboard to press it on), `useUnderFinger()`.
 *
 * The phone's layout (no rail, one column, bigger text) is the window's width, not any of these: the app's media.ts.
 */

/** Keys an on-screen keyboard doesn't send: pressed, a hardware keyboard is in use. */
const HARDWARE_KEYS = /^(Tab|Escape|Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|F\d+)$/

/** What the last press or key said: a finger, or not; unknown until the first. */
let finger: boolean | undefined
const following = new Set<() => void>()
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

function setFinger(next: boolean) {
  const was = underFinger()
  finger = next
  if (next !== was) for (const changed of following) changed()
  document.documentElement.toggleAttribute('data-finger', next)
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Capturing, before anything the press or key opens asks.
  window.addEventListener('pointerdown', (event) => setFinger(event.pointerType === 'touch'), { capture: true, passive: true })
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || HARDWARE_KEYS.test(event.key)) setFinger(false)
  }, { capture: true, passive: true })
  document.documentElement.toggleAttribute('data-finger', coarse())
}

/**
 * Whether the user is working by finger: the last press was a tap, with no mouse or hardware keyboard since; before
 * any, whether the main pointer is a finger (`pointer: coarse`).
 */
export function underFinger(): boolean {
  return finger ?? coarse()
}

/** `underFinger()`, followed: the component draws again as the user goes from a finger to a mouse or a keyboard, or back. */
export function useUnderFinger(): boolean {
  return useSyncExternalStore((changed) => { following.add(changed); return () => following.delete(changed) }, underFinger, () => false)
}

/**
 * Whether a field takes the focus by itself as what holds it opens (a dialog, a palette, a thread, a blank page's
 * address bar): yes, except under a finger, where focus in a field brings up the on-screen keyboard over what just
 * opened. There the field is a tap away. A field the user asked for (a tap on it, Rename, Reply) takes it anyway.
 */
export function autoFocusOnOpen(): boolean {
  return !underFinger()
}

/**
 * A Base UI popup's `initialFocus` (a dialog, a drawer, a combobox): opened by a tap or under a finger, the popup
 * itself holds the focus, so no on-screen keyboard comes up over it; otherwise `fallback`'s (by default, the first
 * thing in it to use).
 */
export function popupFocus(popup: RefObject<HTMLElement | null>, fallback: () => HTMLElement | boolean | null | undefined = () => true) {
  return (openType: string): HTMLElement | boolean | null => openType === 'touch' || underFinger() ? popup.current : fallback() ?? true
}

/**
 * Whether a pointer entering something hovers it: a mouse's, not a finger's or a pen's pressing on it (iOS takes
 * something appearing as the tap lands for a reason to hold the tap back, and wants a second one).
 */
export function hovering(event: { pointerType: string }): boolean {
  return event.pointerType === 'mouse'
}

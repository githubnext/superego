/**
 * Whether the main pointer is a finger (a phone, a tablet), as CSS's `@media (pointer: coarse)` has it: the same test
 * the stylesheets use for what's drawn differently under a finger.
 */
export function underFinger(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

/**
 * Whether a field takes the focus by itself as what holds it opens (a dialog, a palette, a thread, a blank page's
 * address bar): yes, except under a finger, where focus in a field brings up the on-screen keyboard over what just
 * opened. There the field is a tap away. A field the user asked for (a tap on it, Rename, Reply) takes it anyway.
 */
export function autoFocusOnOpen(): boolean {
  return !underFinger()
}

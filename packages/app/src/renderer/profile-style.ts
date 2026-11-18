// A profile's styles reach only what that profile draws: its components are drawn inside an element marked with its
// scope (`data-profile-scope`, see `Contained`), and its CSS (`superego.style`) is wrapped in an `@scope` of that mark,
// which stops at another scope's mark. Two machines running a profile at different versions, or two profiles using the
// same class names, style only their own. The app's and bundled extensions' styles are the window's.

/** The attribute a profile's UI is drawn inside, by scope. */
export const SCOPE_ATTRIBUTE = 'data-profile-scope'

/**
 * A profile's scope (`profileScope`: machine and folder, apart by a NUL) as the attribute's value: URI-encoded, as CSS
 * can't say a NUL, and so it needs no escaping in a selector's string.
 */
export const scopeMark = (scope: string) => encodeURIComponent(scope)

/** `css` applied only inside what's marked with `scope` and not inside another scope's mark within it. */
export function scopedCss(scope: string, css: string) {
  const mine = `[${SCOPE_ATTRIBUTE}="${scopeMark(scope)}"]`
  return `@scope (${mine}) to ([${SCOPE_ATTRIBUTE}]:not(${mine})) {\n${css}\n}`
}

/**
 * Add `css` to the window: a `<style>` in the document's head, scoped to `scope` (a profile's) or the window's. Returns
 * what takes it out again.
 */
export function addStyle(css: string, { extension, scope }: { extension: string; scope?: string | undefined }): () => void {
  const style = document.createElement('style')
  style.dataset.extension = extension
  if (scope !== undefined) style.setAttribute(SCOPE_ATTRIBUTE, scopeMark(scope))
  style.textContent = scope === undefined ? css : scopedCss(scope, css)
  document.head.append(style)
  return () => style.remove()
}

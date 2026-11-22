// Putting text on the clipboard, from a click: a code block's copy button, a sign-in's device code.

/**
 * Puts `text` on the clipboard by selecting it and copying, as a keypress would: at once, with no permission to ask
 * for, and over Web access's plain http too. Focus and the selection go back to where they were.
 */
function copyBySelection(text: string) {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : []
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;user-select:text'
  document.body.append(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } finally {
    area.remove()
    focused?.focus({ preventScroll: true })
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range) }
  }
  return ok
}

/** Put `text` on the clipboard; rejects when there's no way to here. */
export async function copyText(text: string) {
  if (copyBySelection(text)) return
  if (!navigator.clipboard) throw new Error('No way to copy here')
  await navigator.clipboard.writeText(text)
}

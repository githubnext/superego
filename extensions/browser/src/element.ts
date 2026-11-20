// An element picked in a Browser pane's page (picker.ts), as it goes to the agent: a note of what it is (where, its
// selector, its tag and text, its box and styles, its HTML) as a text file the agent reads inline, with an image of it
// after. And that note found again in a sent message, for its chip there.
import type { Attachment } from '@superego/protocol'
import type { Picked } from './picker.ts'

/** The note's type: text, so the agent is given it whole, and its own, so it's found again in a sent message. */
export const ELEMENT_TYPE = 'text/vnd.superego.element+markdown'
/** How much of an element's outer HTML goes with it. */
export const HTML_LIMIT = 6 * 1024

const kb = (chars: number) => `${(chars / 1024).toFixed(chars < 10 * 1024 ? 1 : 0)} KB`

/** Where the page is, for a chip: a web page's host, a file's name. */
export const whereOf = (address: string) => {
  if (/^https?:/i.test(address)) {
    try { return new URL(address).host } catch { return address }
  }
  return address.split(/[?#]/)[0]!.split('/').at(-1) || address
}

/** The note to the agent of an element picked at `address` (as the pane's address bar says it), with an image of it after or not. */
export function elementNote(picked: Picked, address: string, image: boolean): string {
  const { box, viewport } = picked
  const styles = Object.entries(picked.styles).map(([name, value]) => `${name}: ${value}`).join('; ')
  const longest = Math.max(0, ...(picked.html.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const cut = picked.html.length < picked.htmlSize
  return [
    `The element I picked in the Browser pane: ${picked.label} on ${address}${picked.title ? ` ("${picked.title}")` : ''}.`,
    '',
    `- Selector: \`${picked.selector}\``,
    `- Tag: \`${picked.opening}\``,
    ...(picked.text ? [`- Text: "${picked.text}"`] : []),
    `- Box: ${box.width} × ${box.height} at (${box.x}, ${box.y}), in a ${viewport.width} × ${viewport.height} viewport`,
    `- Styles: \`${styles}\``,
    ...(image ? ['- Screenshot: the image attached after this'] : []),
    '',
    cut ? `Its HTML, cut to the first ${kb(picked.html.length)} of ${kb(picked.htmlSize)}:` : 'Its HTML:',
    '',
    fence + 'html',
    picked.html,
    fence,
  ].join('\n')
}

/** A text's bytes as UTF-8, in base64. */
export function base64(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let binary = ''
  for (let at = 0; at < data.length; at += 0x8000) binary += String.fromCharCode(...data.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** What goes with the message: the note, and the image (a PNG's base64) after it. */
export function elementFiles(picked: Picked, address: string, image: string | undefined): Attachment[] {
  return [
    { name: 'element.md', mimeType: ELEMENT_TYPE, data: base64(elementNote(picked, address, Boolean(image))) },
    ...(image ? [{ name: 'element.png', mimeType: 'image/png', data: image }] : []),
  ]
}

/** An element as a sent message's chip says it: `<button.primary>`, where (`localhost:4321`), and its selector. */
export type SentElement = { label: string; where: string; selector: string }

const TAG = new RegExp(`^<attachment name="[^"]*" type="${ELEMENT_TYPE.replace(/[.+]/g, '\\$&')}" path="[^"]*">\\n`)

/** The element a sent message's block (`<attachment …>` with the note inline) tells of; none for any other block. */
export function readElement(text: string | undefined): SentElement | undefined {
  if (!text || !TAG.test(text)) return undefined
  const head = /^The element I picked in the Browser pane: (.+?) on (\S+?)(?: \(".*"\))?\.$/m.exec(text)
  const selector = /^- Selector: `(.*)`$/m.exec(text)
  if (!head) return undefined
  return { label: head[1]!, where: whereOf(head[2]!), selector: selector?.[1] ?? '' }
}

// What a file is, by its bytes rather than its name: PNG, JPEG, GIF, WebP or SVG, and how big it is in pixels where
// the header says: so a thread can keep a shown image's place before it loads, and an image sent to the model is decoded
// only when it's too big for it (model-images.ts).

export type Sniffed = { mimeType: string; ext: string; width?: number; height?: number }

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))

/** The image `bytes` hold, or undefined when they aren't one of the kinds shown. */
export function sniff(bytes: Uint8Array): Sniffed | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : {}
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG' && bytes[0] === 0x89) {
    return { mimeType: 'image/png', ext: 'png', ...size(view.getUint32(16), view.getUint32(20)) }
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    return { mimeType: 'image/gif', ext: 'gif', ...size(view.getUint16(6, true), view.getUint16(8, true)) }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg', ...jpegSize(bytes, view) }
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { mimeType: 'image/webp', ext: 'webp', ...webpSize(bytes, view) }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart()
  if (/^(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text)) {
    return { mimeType: 'image/svg+xml', ext: 'svg', ...svgSize(text) }
  }
  return undefined
}

/** A JPEG's size from its first start-of-frame marker. */
function jpegSize(bytes: Uint8Array, view: DataView) {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return {}
    const marker = bytes[at + 1]!
    // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(at + 5)
      const width = view.getUint16(at + 7)
      return width && height ? { width, height } : {}
    }
    at += 2 + view.getUint16(at + 2)
  }
  return {}
}

/** A WebP's size from its first chunk: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webpSize(bytes: Uint8Array, view: DataView) {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const u24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
    return { width: u24(24) + 1, height: u24(27) + 1 }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return {}
}

/** An SVG's size from its width and height in pixels, else its viewBox. */
function svgSize(text: string) {
  const tag = /<svg[^>]*>/i.exec(text)?.[0] ?? ''
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]
  const px = (value: string | undefined) => value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? parseFloat(value) : undefined
  const width = px(attr('width'))
  const height = px(attr('height'))
  if (width && height) return { width, height }
  const box = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! }
  return {}
}

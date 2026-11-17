// Small images of each kind, made here: a real PNG (it is shown in tests), and the headers of the others.
import { deflateSync } from 'node:zlib'

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A `width`×`height` PNG of one colour. */
export function png(width: number, height: number, [r, g, b] = [80, 140, 220]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', new Uint8Array())]))
}

export function gif(width: number, height: number) {
  const out = Buffer.alloc(13)
  out.write('GIF89a', 0, 'latin1')
  out.writeUInt16LE(width, 6)
  out.writeUInt16LE(height, 8)
  return new Uint8Array(out)
}

/** SOI, an APP0 segment to skip, then a baseline frame header. */
export function jpeg(width: number, height: number) {
  const out = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  out.writeUInt16BE(height, 25)
  out.writeUInt16BE(width, 27)
  return new Uint8Array(out)
}

/** An extended (VP8X) WebP header. */
export function webp(width: number, height: number) {
  const out = Buffer.alloc(30)
  out.write('RIFF', 0, 'latin1')
  out.writeUInt32LE(22, 4)
  out.write('WEBPVP8X', 8, 'latin1')
  out.writeUInt32LE(10, 16)
  out.writeUIntLE(width - 1, 24, 3)
  out.writeUIntLE(height - 1, 27, 3)
  return new Uint8Array(out)
}

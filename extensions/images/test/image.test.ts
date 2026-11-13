import { expect, it } from 'vitest'
import { sniff } from '../src/image.ts'
import { gif, jpeg, png, webp } from './fixtures.ts'

it('tells an image by its bytes, with its size in pixels', () => {
  expect(sniff(png(40, 30))).toEqual({ mimeType: 'image/png', ext: 'png', width: 40, height: 30 })
  expect(sniff(gif(7, 9))).toEqual({ mimeType: 'image/gif', ext: 'gif', width: 7, height: 9 })
  expect(sniff(jpeg(640, 480))).toEqual({ mimeType: 'image/jpeg', ext: 'jpg', width: 640, height: 480 })
  expect(sniff(webp(300, 200))).toEqual({ mimeType: 'image/webp', ext: 'webp', width: 300, height: 200 })
})

it('reads an SVG’s size from width and height, else its viewBox', () => {
  const svg = (text: string) => new TextEncoder().encode(text)
  expect(sniff(svg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>'))).toEqual({ mimeType: 'image/svg+xml', ext: 'svg', width: 120, height: 80 })
  expect(sniff(svg('<?xml version="1.0"?>\n<!-- a chart -->\n<svg viewBox="0 0 400 300" width="100%"></svg>'))).toEqual({ mimeType: 'image/svg+xml', ext: 'svg', width: 400, height: 300 })
  expect(sniff(svg('<svg><rect/></svg>'))).toEqual({ mimeType: 'image/svg+xml', ext: 'svg' })
})

it('refuses what isn’t an image, whatever it is called', () => {
  expect(sniff(new TextEncoder().encode('# A note\n\n<svg> in prose\n'))).toBeUndefined()
  expect(sniff(new TextEncoder().encode('<html><body><svg></svg></body></html>'))).toBeUndefined()
  expect(sniff(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBeUndefined()
  expect(sniff(new Uint8Array())).toBeUndefined()
})

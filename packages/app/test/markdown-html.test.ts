import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { folderOf, htmlPlugins, imagePath, imageType, mediaMatches, parseSrcset, resolve } from '../src/renderer/markdown-html.ts'

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: htmlPlugins, urlTransform: (url: string) => url }, text))

describe('HTML in a rendered file', () => {
  it('keeps a picture with its sources and image', () => {
    const html = render('<picture><source media="(prefers-color-scheme: dark)" srcset="d/dark.svg"><img src="d/light.svg" alt="A diagram" width="400"></picture>')
    expect(html).toContain('<picture>')
    expect(html).toContain('<source media="(prefers-color-scheme: dark)" srcSet="d/dark.svg"/>')
    expect(html).toContain('<img src="d/light.svg" alt="A diagram" width="400"/>')
  })

  it('keeps what documents use: details, kbd, sub and sup, br, aligned blocks, srcset', () => {
    const html = render('<p align="center"><img src="a.png" srcset="a.png 1x, a@2x.png 2x"></p>\n\n<details><summary>More</summary>Press <kbd>⌘K</kbd>, H<sub>2</sub>O, x<sup>2</sup><br>done</details>')
    expect(html).toContain('<p align="center">')
    expect(html).toContain('srcSet="a.png 1x, a@2x.png 2x"')
    for (const tag of ['<details>', '<summary>More</summary>', '<kbd>⌘K</kbd>', '<sub>2</sub>', '<sup>2</sup>', '<br/>']) expect(html).toContain(tag)
  })

  it('strips scripts, event handlers, styles and script URLs', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)" style="position:fixed"><a href="javascript:alert(3)">x</a><iframe src="https://e.com"></iframe><style>body{display:none}</style>')
    expect(html).not.toMatch(/script|alert|onerror|style|iframe|position/i)
    expect(html).toContain('<img src="x.png"/>')
  })

  it("keeps a message's own links, to files and threads, and GFM's tables and task lists", () => {
    const html = render('[note](<superego-file:a.md>) and [t](thread:abc)\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- [x] done')
    expect(html).toContain('href="superego-file:a.md"')
    expect(html).toContain('href="thread:abc"')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
  })
})

describe('relative paths', () => {
  it('resolves against the document’s folder, inside the thread’s', () => {
    expect(folderOf('docs/writing-extensions.md')).toBe('docs/')
    expect(folderOf('README.md')).toBe('')
    expect(imagePath('docs/', 'writing-extensions/big-picture.svg')).toBe('docs/writing-extensions/big-picture.svg')
    expect(imagePath('docs/', './a%20b.png?v=2#x')).toBe('docs/a b.png')
    expect(imagePath('docs/guide/', '../img/x.png')).toBe('docs/img/x.png')
    expect(imagePath('', '../outside.png')).toBeUndefined()
    expect(imagePath('docs/', '/etc/passwd')).toBeUndefined()
    expect(imagePath('docs/', 'https://example.com/a.png')).toBeUndefined()
    expect(resolve('a/', 'b/../c.md')).toBe('a/c.md')
  })

  it('reads a srcset', () => {
    expect(parseSrcset(' a.png 1x, b.png 2x,c.png ')).toEqual([{ url: 'a.png', descriptor: '1x' }, { url: 'b.png', descriptor: '2x' }, { url: 'c.png', descriptor: '' }])
  })

  it('types images, SVGs especially', () => {
    expect(imageType('a/b.SVG')).toBe('image/svg+xml')
    expect(imageType('b.jpg')).toBe('image/jpeg')
    expect(imageType('b.txt')).toBe('')
  })
})

describe('picture sources', () => {
  const never = () => { throw new Error('asked the window') }
  it("answers prefers-color-scheme by the app's theme", () => {
    expect(mediaMatches('(prefers-color-scheme: dark)', true, never)).toBe(true)
    expect(mediaMatches('(prefers-color-scheme: dark)', false, never)).toBe(false)
    expect(mediaMatches(' ( prefers-color-scheme : light ) ', false, never)).toBe(true)
    expect(mediaMatches(undefined, true, never)).toBe(true)
  })
  it('leaves the rest of a query to the window', () => {
    const asked: string[] = []
    const match = (query: string) => { asked.push(query); return true }
    mediaMatches('(prefers-color-scheme: dark) and (min-width: 600px)', false, match)
    expect(asked).toEqual(['(max-width: -1px) and (min-width: 600px)'])
  })
})


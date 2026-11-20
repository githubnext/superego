import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { folderOf, htmlPlugins, imageSource, imageType, looksLikePath, mediaMatches, parseSrcset, resolve } from '../src/renderer/markdown-html.ts'

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: htmlPlugins(['ticket']), urlTransform: (url: string) => url }, text))

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

  it("keeps links of the schemes handlers claim, and only those, and GFM's tables and task lists", () => {
    const html = render('[note](<wikilink:a.md>) and [t](thread:abc) and <a href="ticket:12">a ticket</a>\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- [x] done')
    expect(html).toContain('href="ticket:12"')
    // Nothing here claims files or threads.
    expect(html).not.toContain('wikilink:a.md')
    expect(html).not.toContain('thread:abc')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
  })
})

describe('relative paths', () => {
  it('resolves against the document’s folder', () => {
    expect(folderOf('docs/writing-extensions.md')).toBe('docs/')
    expect(folderOf('README.md')).toBe('')
    const file = (src: string) => imageSource(src, { dir: 'docs/' })
    expect(file('writing-extensions/big-picture.svg')).toEqual({ path: 'docs/writing-extensions/big-picture.svg' })
    expect(file('./a%20b.png?v=2#x')).toEqual({ path: 'docs/a b.png' })
    expect(imageSource('../img/x.png', { dir: 'docs/guide/' })).toEqual({ path: 'docs/img/x.png' })
    expect(resolve('a/', 'b/../c.md')).toBe('a/c.md')
  })

  it('goes past the thread’s folder, and from a document elsewhere', () => {
    expect(imageSource('../../outside.png', { dir: 'docs/' })).toEqual({ path: '../outside.png' })
    expect(resolve('', '../../x.md')).toBe('../../x.md')
    expect(resolve('/Users/me/.superego/', 'notes/a.md')).toBe('/Users/me/.superego/notes/a.md')
    expect(resolve('/Users/me/', '../../../etc/hosts')).toBe('/etc/hosts')
    expect(resolve('~/notes/', '../a.md')).toBe('~/a.md')
    expect(resolve('~/', '../a.md')).toBe('~/../a.md')
    expect(resolve('docs/', '/etc/hosts')).toBe('/etc/hosts')
    expect(resolve('docs/', '~/a.md')).toBe('~/a.md')
    expect(resolve('docs/', '~a.md')).toBe('docs/~a.md')
    expect(resolve('docs/', 'https://x.com')).toBeUndefined()
  })
})

describe('images in a thread', () => {
  const at = (src: string) => imageSource(src)

  it('reads a relative path from the thread’s folder', () => {
    expect(at('shots/a.png')).toEqual({ path: 'shots/a.png' })
    expect(at('./a b.png')).toEqual({ path: 'a b.png' })
    expect(at('shots/../a.png')).toEqual({ path: 'a.png' })
  })

  it('reads any path on the thread’s machine: absolute, from home, or a local file:// address', () => {
    expect(at('/Users/me/dev/dinky/./a/../b.png')).toEqual({ path: '/Users/me/dev/dinky/b.png' })
    expect(at('/etc/x.png')).toEqual({ path: '/etc/x.png' })
    expect(at('~/Desktop/a.png')).toEqual({ path: '~/Desktop/a.png' })
    expect(at('file:///Users/me/dev/dinky/c%20d.png')).toEqual({ path: '/Users/me/dev/dinky/c d.png' })
    expect(at('file://elsewhere/Users/me/dev/dinky/a.png')).toHaveProperty('refused')
  })

  it('shows web, data and blob addresses as they are; refuses other schemes', () => {
    expect(at('https://example.com/a.png?x=1')).toEqual({ url: 'https://example.com/a.png?x=1' })
    expect(at('http://localhost:3000/a.png')).toEqual({ url: 'http://localhost:3000/a.png' })
    expect(at('data:image/png;base64,AAAA')).toEqual({ url: 'data:image/png;base64,AAAA' })
    expect(at('blob:http://x/1')).toEqual({ url: 'blob:http://x/1' })
    expect(at('javascript:alert(1)')).toHaveProperty('refused')
    expect(at('')).toHaveProperty('refused')
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

describe('code that names a file', () => {
  it('takes paths and file names', () => {
    for (const text of ['src/app.ts', 'notes/plan.md', 'README.md', 'docs/guides/', 'plan.md:12', 'package.json', '~/notes/a.txt', 'Cargo.lock',
      'daemon.ts', 'packages/daemon/src/extension.ts', '/Users/mikker/dev/gh/superego', 'src/app.ts:12:4'])
      expect(looksLikePath(text), text).toBe(true)
  })
  it("doesn't take dotted code", () => {
    for (const text of ['settings.get', 'settings.onChange', 'foo.bar()', 'x.y', 'superego.pane', 'thread.list', 'https://e.com/a.md', 'a.md b'])
      expect(looksLikePath(text), text).toBe(false)
  })
  it("doesn't take a command that names a path", () => {
    for (const text of ['git -C /Users/mikker/dev/gh/superego merge --ff-only <your-branch>', 'cat src/app.ts', 'pnpm --filter superego smoke', 'open README.md', 'notes/a plan.md'])
      expect(looksLikePath(text), text).toBe(false)
  })
})

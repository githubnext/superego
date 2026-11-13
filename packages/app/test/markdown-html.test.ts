import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { folderOf, htmlPlugins, imageSource, imageType, OUTSIDE, looksLikePath, mediaMatches, parseSrcset, resolve } from '../src/renderer/markdown-html.ts'

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
  it('resolves against the document’s folder, inside the thread’s', () => {
    expect(folderOf('docs/writing-extensions.md')).toBe('docs/')
    expect(folderOf('README.md')).toBe('')
    const file = (src: string) => imageSource(src, { cwd: '/repo', dir: 'docs/' })
    expect(file('writing-extensions/big-picture.svg')).toEqual({ path: 'docs/writing-extensions/big-picture.svg' })
    expect(file('./a%20b.png?v=2#x')).toEqual({ path: 'docs/a b.png' })
    expect(imageSource('../img/x.png', { cwd: '/repo', dir: 'docs/guide/' })).toEqual({ path: 'docs/img/x.png' })
    expect(file('../../outside.png')).toEqual({ refused: OUTSIDE })
    expect(file('/etc/passwd')).toEqual({ refused: OUTSIDE })
    expect(resolve('a/', 'b/../c.md')).toBe('a/c.md')
  })
})

describe('images in a thread', () => {
  const cwd = '/Users/me/dev/dinky'
  const at = (src: string) => imageSource(src, { cwd, thread: 't1' })

  it('reads a relative path from the thread’s folder', () => {
    expect(at('shots/a.png')).toEqual({ path: 'shots/a.png' })
    expect(at('./a b.png')).toEqual({ path: 'a b.png' })
    expect(at('shots/../a.png')).toEqual({ path: 'a.png' })
  })

  it('reads an absolute path inside the thread’s folder, as one in it', () => {
    expect(at('/Users/me/dev/dinky/build/reviews/pr-77/corner-comparison.png')).toEqual({ path: 'build/reviews/pr-77/corner-comparison.png' })
    expect(at('/Users/me/dev/dinky/./a/../b.png')).toEqual({ path: 'b.png' })
    expect(at('file:///Users/me/dev/dinky/c%20d.png')).toEqual({ path: 'c d.png' })
  })

  it('refuses a path outside the thread’s folder', () => {
    expect(at('../other/a.png')).toEqual({ refused: OUTSIDE })
    expect(at('/Users/me/dev/dinky-other/a.png')).toEqual({ refused: OUTSIDE })
    expect(at('/Users/me/dev/dinky/../secret.png')).toEqual({ refused: OUTSIDE })
    expect(at('/etc/passwd')).toEqual({ refused: OUTSIDE })
    expect(at('file://elsewhere/Users/me/dev/dinky/a.png')).toHaveProperty('refused')
  })

  it('takes ~ as the home the thread’s folder is in', () => {
    expect(at('~/dev/dinky/a.png')).toEqual({ path: 'a.png' })
    expect(at('~/Desktop/a.png')).toEqual({ refused: OUTSIDE })
    expect(imageSource('~/a.png', { cwd: '/home/me/x' })).toEqual({ refused: OUTSIDE })
    expect(imageSource('~/x/a.png', { cwd: '/home/me/x' })).toEqual({ path: 'a.png' })
    expect(imageSource('~/a.png', { cwd: '/srv/app' })).toEqual({ refused: OUTSIDE })
  })

  it('leaves the files the thread keeps to its machine to read', () => {
    expect(at('/Users/me/.superego/attachments/t1/shown/x.png')).toEqual({ path: '/Users/me/.superego/attachments/t1/shown/x.png' })
    expect(at('/Users/me/.superego/attachments/t2/shown/x.png')).toEqual({ refused: OUTSIDE })
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

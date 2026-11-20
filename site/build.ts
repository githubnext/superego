// Builds the public site into site/dist: a home page, the docs and the changelog, from the repo's own Markdown
// (pages.ts lists which). Plain HTML and one stylesheet; code is coloured here, so pages need no JavaScript.
// `SITE_BASE` is the path the site is served under (`/superego/` on GitHub Pages; `/` by default). `SITE_DEV` adds the
// dev server's live reload. Every link inside the site is checked at the end: a broken one fails the build.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5'
import { highlight } from './highlight.ts'
import { homeBody } from './home.ts'
import { changelog, sections, type Page } from './pages.ts'

type Node = DefaultTreeAdapterMap['childNode'] | DefaultTreeAdapterMap['documentFragment']
type Element = DefaultTreeAdapterMap['element']

const SITE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SITE, '..')
const OUT = process.env.SITE_OUT ?? join(SITE, 'dist')
const REPO = 'https://github.com/githubnext/superego'
const DOWNLOAD = `${REPO}/releases/latest`
const BASE = (process.env.SITE_BASE ?? '/').replace(/\/?$/, '/')
const DEV = Boolean(process.env.SITE_DEV)
/** Where the site is published, for what needs a full address: the link preview's image. */
const SITE_URL = (process.env.SITE_URL ?? 'https://githubnext.github.io/superego').replace(/\/?$/, '/')

const docs = sections.flatMap((s) => s.pages)
const pageBySrc = new Map([...docs, changelog].map((p) => [p.src, p]))
const urlOf = (page: Page) => (page === changelog ? `${BASE}changelog/` : `${BASE}docs/${page.slug ? `${page.slug}/` : ''}`)

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---------------------------------------------------------------------------------------------------------------------
// Markdown: the sections a page keeps, as HTML

/** The page's Markdown, without front matter, its `#` title, the sections it drops and (with `intro: false`) its intro. */
function markdownOf(page: Page): string {
  const lines = readFileSync(join(ROOT, page.src), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
  const kept: string[] = []
  const unfound = new Set(page.drop ?? [])
  let fence = ''
  let dropping = 0 // the level of the heading being dropped, 0 when keeping
  let intro = true
  for (const line of lines) {
    const opens = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (opens && opens[0] === fence[0] && opens.length >= fence.length) fence = ''
    } else if (opens) {
      fence = opens
    } else {
      const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
      if (heading) {
        const level = heading[1]!.length
        const text = heading[2]!
        if (level === 1) continue
        if (level === 2) intro = false
        if (dropping && level <= dropping) dropping = 0
        if (!dropping && unfound.delete(text)) dropping = level
      }
    }
    if (dropping || (intro && page.intro === false)) continue
    kept.push(line)
  }
  if (unfound.size) throw new Error(`${page.src}: no heading ${[...unfound].map((h) => `"${h}"`).join(', ')} to drop (site/pages.ts)`)
  return kept
    .join('\n')
    .replace(/^\*\*Status:\*\*[\s\S]*?\n\n/m, '') // a design doc's status line is for its authors
    .replace(/\n+-{3,}\n+/g, '\n\n') // thematic breaks between sections: the headings already part them
}

/** GitHub's heading ids, so links written for GitHub land here too. */
function slugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '').replace(/ /g, '-')
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

const textOf = (node: Node): string =>
  'value' in node && node.nodeName === '#text' ? node.value : 'childNodes' in node ? node.childNodes.map(textOf).join('') : ''
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)
const isElement = (node: Node): node is Element => 'tagName' in node

function walk(node: Node, visit: (el: Element) => void) {
  if (isElement(node)) visit(node)
  if ('childNodes' in node) for (const child of [...node.childNodes]) walk(child, visit)
}

/** Where a link in `from` (a repo path) goes on the site: a page, a copied asset, or the file on GitHub. */
function resolveLink(href: string, from: string, asset: boolean): string {
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) return href
  const [path = '', hash] = href.split('#')
  const target = posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '')
  const anchor = hash ? `#${hash}` : ''
  const page = pageBySrc.get(target)
  if (page) return urlOf(page) + anchor
  const file = join(ROOT, target)
  if (!existsSync(file)) throw new Error(`${from}: links to ${href}, which isn't in the repo`)
  if (asset) {
    mkdirSync(dirname(join(OUT, 'assets', target)), { recursive: true })
    cpSync(file, join(OUT, 'assets', target))
    return `${BASE}assets/${target}`
  }
  return `${REPO}/${statSync(file).isDirectory() ? 'tree' : 'blob'}/main/${target}${anchor}`
}

type Rendered = { html: string; toc: { id: string; text: string }[] }

function render(page: Page): Rendered {
  const html = micromark(markdownOf(page), { allowDangerousHtml: true, extensions: [gfm()], htmlExtensions: [gfmHtml()] })
  const tree = parseFragment(html)
  const slug = slugger()
  const toc: Rendered['toc'] = []
  walk(tree, (el) => {
    if (/^h[2-6]$/.test(el.tagName)) {
      const text = textOf(el).trim()
      const id = slug(text)
      el.attrs.push({ name: 'id', value: id })
      if (el.tagName === 'h2') toc.push({ id, text })
    }
    const href = attr(el, 'href')
    if (el.tagName === 'a' && href) {
      href.value = resolveLink(href.value, page.src, false)
      if (/^https?:/.test(href.value) && !href.value.startsWith(BASE)) el.attrs.push({ name: 'rel', value: 'noopener' })
    }
    const src = attr(el, 'src')
    if (el.tagName === 'img' && src) src.value = resolveLink(src.value, page.src, true)
    const srcset = attr(el, 'srcset')
    if (el.tagName === 'source' && srcset) srcset.value = resolveLink(srcset.value, page.src, true)
    if (el.tagName === 'code' && el.parentNode?.nodeName === 'pre') {
      const lang = /language-(\S+)/.exec(attr(el, 'class')?.value ?? '')?.[1] ?? ''
      el.childNodes = parseFragment(highlight(textOf(el).replace(/\n$/, ''), lang)).childNodes
      for (const child of el.childNodes) child.parentNode = el
    }
    if (el.tagName === 'table' && el.parentNode) {
      // Wide tables scroll on their own, not the page.
      const wrap = parseFragment('<div class="table"></div>').childNodes[0] as Element
      const siblings = el.parentNode.childNodes
      siblings[siblings.indexOf(el)] = wrap
      wrap.parentNode = el.parentNode
      wrap.childNodes = [el]
      el.parentNode = wrap
    }
  })
  return { html: serialize(tree), toc }
}

// ---------------------------------------------------------------------------------------------------------------------
// Templates

const icon = `<svg viewBox="27.45 19.6 51.1 58.4" aria-hidden="true"><path transform="rotate(-14 53 31)" fill="currentColor" fill-rule="evenodd" d="M28.5 31 a24.5 9.5 0 1 0 49.0 0 a24.5 9.5 0 1 0 -49.0 0 Z M33.5 31 a19.5 4.5 0 1 0 39.0 0 a19.5 4.5 0 1 0 -39.0 0 Z"/><circle cx="50" cy="62" r="16" fill="currentColor"/></svg>`

function layout(o: { title: string; description?: string; current?: 'docs' | 'changelog'; body: string; wide?: boolean }) {
  const nav = (href: string, label: string, here: boolean) => `<a href="${href}"${here ? ' aria-current="page"' : ''}>${label}</a>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(o.title)}</title>
<meta name="description" content="${escape(o.description ?? DESCRIPTION)}">
<meta name="color-scheme" content="light dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Superego">
<meta property="og:title" content="${escape(o.title)}">
<meta property="og:description" content="${escape(o.description ?? DESCRIPTION)}">
<meta property="og:image" content="${SITE_URL}og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Superego icon, a halo over a dot, on a blue swirl">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${BASE}icon.png">
<link rel="stylesheet" href="${BASE}style.css">
</head>
<body>
<header class="top${o.wide ? ' wide' : ''}">
<a class="name" href="${BASE}">${icon}Superego</a>
<nav>${nav(`${BASE}docs/`, 'Docs', o.current === 'docs')}${nav(`${BASE}changelog/`, 'Changelog', o.current === 'changelog')}<a href="${REPO}">GitHub</a></nav>
</header>
${o.body}
${DEV ? `<script>new EventSource('/__reload').onmessage = () => location.reload()</script>\n` : ''}</body>
</html>
`
}

const DESCRIPTION =
  'An agent workbench you make your own: a small shell for running agents, on this Mac or over ssh, with panes beside them. The rest is profiles and extensions.'

function home() {
  return layout({ title: 'Superego', body: homeBody({ base: BASE, download: DOWNLOAD, repo: REPO }) })
}

function docPage(page: Page, { html, toc }: Rendered) {
  const sidebar = sections
    .map(
      (s) => `<h2>${s.title}</h2>
<ul>${s.pages
        .map((p) => {
          const here = p === page
          const sub = here && toc.length > 1 ? `<ul>${toc.map((h) => `<li><a href="#${h.id}">${escape(h.text)}</a></li>`).join('')}</ul>` : ''
          return `<li><a href="${urlOf(p)}"${here ? ' aria-current="page"' : ''}>${p.title}</a>${sub}</li>`
        })
        .join('')}</ul>`,
    )
    .join('\n')
  return layout({
    title: `${page.title} · Superego docs`,
    current: 'docs',
    wide: true,
    body: `<div class="docs">
<nav class="sidebar" aria-label="Docs">
${sidebar}
</nav>
<main class="prose">
<h1>${page.title}</h1>
${html}
<p class="source"><a href="${REPO}/blob/main/${page.src}">${page.src}</a></p>
</main>
</div>`,
  })
}

function changelogPage({ html }: Rendered) {
  return layout({
    title: 'Changelog · Superego',
    current: 'changelog',
    body: `<main class="prose single">
<h1>Changelog</h1>
${html}
</main>`,
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing, then checking every link inside the site

function write(path: string, html: string) {
  const file = join(OUT, path, 'index.html')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]))
}

/** Every href, src and srcset under BASE resolves to a file, and every #anchor to an id on its page. */
function checkLinks() {
  const html = files(OUT).filter((f) => f.endsWith('.html'))
  const ids = new Map(html.map((f) => [f, new Set([...readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]))
  const broken: string[] = []
  for (const file of html) {
    for (const [, , value] of readFileSync(file, 'utf8').matchAll(/\s(href|src|srcset)="([^"]*)"/g)) {
      const link = value!.replace(/&amp;/g, '&')
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) continue
      const [path = '', hash] = link.split('#')
      let target = file
      if (path) {
        if (!path.startsWith(BASE)) {
          broken.push(`${posix.relative(OUT, file)}: ${link} (not under ${BASE})`)
          continue
        }
        const local = join(OUT, decodeURIComponent(path.slice(BASE.length)))
        target = path.endsWith('/') ? join(local, 'index.html') : local
      }
      if (!existsSync(target)) broken.push(`${posix.relative(OUT, file)}: ${link}`)
      else if (hash && !ids.get(target)?.has(decodeURIComponent(hash))) broken.push(`${posix.relative(OUT, file)}: ${link} (no #${hash})`)
    }
  }
  if (broken.length) throw new Error(`Broken links:\n  ${broken.join('\n  ')}`)
  return html.length
}

/** @superego/ui's :root block: the app's colours (syntax too), fonts and radius, as the window has them. */
function appTokens() {
  const css = readFileSync(join(ROOT, 'packages/ui/src/styles.css'), 'utf8')
  const root = /^:root \{\n[\s\S]*?\n\}\n/m.exec(css)?.[0]
  if (!root?.includes('--superego-syntax-keyword')) throw new Error("packages/ui/src/styles.css: no :root block with the --superego-syntax-* tokens")
  return `/* From packages/ui/src/styles.css */\n${root}`
}

export function build() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'style.css'), `${appTokens()}\n${readFileSync(join(SITE, 'style.css'), 'utf8')}`)
  // The window, from `app/test/look.sh <dir> staff`: staff-wide-light.png and -dark.png (cwebp -q 82).
  for (const shot of ['screenshot-light.webp', 'screenshot-dark.webp']) cpSync(join(SITE, shot), join(OUT, shot))
  // The byline's avatars, from avatars.githubusercontent.com.
  for (const avatar of ['mikker.png', 'githubnext.png']) cpSync(join(SITE, avatar), join(OUT, avatar))
  // The link preview: docs/header.webp (the README's), cropped to 1200×630.
  cpSync(join(SITE, 'og.png'), join(OUT, 'og.png'))
  cpSync(join(ROOT, 'app/resources/icon.png'), join(OUT, 'icon.png'))
  write('', home())
  for (const page of docs) write(urlOf(page).slice(BASE.length), docPage(page, render(page)))
  write('changelog', changelogPage(render(changelog)))
  // GitHub Pages runs Jekyll over the site unless told not to.
  writeFileSync(join(OUT, '.nojekyll'), '')
  return checkLinks()
}

if (import.meta.main) {
  const started = performance.now()
  const pages = build()
  console.log(`Built ${pages} pages into ${OUT} in ${Math.round(performance.now() - started)} ms`)
}

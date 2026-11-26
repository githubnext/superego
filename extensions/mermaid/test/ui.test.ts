// @vitest-environment happy-dom
// A ```mermaid block in Markdown, drawn by Pele as an SVG diagram; its corner shows the source instead or copies it.
// Half-written source while a message streams stays quiet; source that won't draw once it's done is shown with why.
// A thread that goes without the extension sees the block as code.
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { createRegistry, LinkPlace, RegistryProvider, type Registry } from '@superego/app/internals'
import { Markdown } from '@superego/app/ui'
import mermaid, { loadPele } from '../src/ui.tsx'

const app = defineApp({ name: 'superego', id: 'superego' })
const thread = (more: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: '1', title: 't', cwd: '/', createdAt: 0, activeAt: 0, project: { root: '/', name: '/' }, status: { state: 'idle' }, ...more,
})
const fence = (code: string) => `\`\`\`mermaid\n${code}\n\`\`\`\n`

const STATES = 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Working: send\n  Working --> Done: finish\n  Done --> [*]'
const FLOW = 'flowchart LR\n  api["API (v2)"] -->|request| db[(Database)]'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const visible = (selector: string) => { const el = $(selector); return Boolean(el && !el.closest('[hidden]')) }

// happy-dom lays nothing out: a column 640px wide, so Pele draws (and draws again) as it would in the window.
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
beforeAll(async () => {
  // Loaded as the first diagram shows; here before, so each draws in the act that draws it.
  await loadPele()
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => { if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth) })

let registry: Registry
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  registry?.teardown()
  document.body.innerHTML = ''
})

function draw(text: string, options: { streaming?: boolean; thread?: ThreadInfo } = {}) {
  const tree = h(RegistryProvider, { registry, children: h(LinkPlace.Provider, { value: { machine: 'local', thread: options.thread ?? thread() } },
    h(Markdown, { text, streaming: options.streaming ?? false })) })
  if (!root) {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root!.render(tree))
}

const click = (selector: string) => act(() => { $(selector)!.click() })

it('draws a state diagram and a flowchart as SVG', () => {
  registry = createRegistry(app, [mermaid], () => {})
  draw(`${fence(STATES)}\n${fence(FLOW)}`)
  const diagrams = document.querySelectorAll('.mermaid .mermaid__diagram')
  expect(diagrams).toHaveLength(2)
  for (const diagram of diagrams) expect(diagram.querySelector('svg')).not.toBeNull()
  expect(diagrams[0]!.textContent).toContain('Working')
  expect(diagrams[1]!.textContent).toContain('API (v2)')
  // No fallback code block, no note.
  expect($('.md__code')).toBeNull()
  expect($('.mermaid__problem')).toBeNull()
})

it('shows the source instead, and back, and copies the source', async () => {
  registry = createRegistry(app, [mermaid], () => {})
  draw(fence(FLOW))
  expect(visible('.mermaid__diagram svg')).toBe(true)
  click('[aria-label="Show source"]')
  expect(visible('.mermaid__diagram svg')).toBe(false)
  expect($('.mermaid__source code')!.textContent).toBe(FLOW)
  click('[aria-label="Show diagram"]')
  expect(visible('.mermaid__diagram svg')).toBe(true)
  expect($('.mermaid__source')).toBeNull()

  const copied: string[] = []
  const execCommand = document.execCommand
  document.execCommand = () => false
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  try {
    await act(async () => { $('[aria-label="Copy source"]')!.click() })
    expect(copied).toEqual([FLOW])
    expect($('.mermaid__tool.is-copied')?.getAttribute('aria-label')).toBe('Copied')
  } finally { document.execCommand = execCommand }
})

it('keeps quiet while half-written source streams in, and keeps the last diagram that drew', () => {
  registry = createRegistry(app, [mermaid], () => {})
  // Nothing drawn yet: the source as it comes, no note.
  draw(fence('flowchart LR\n  a -->'), { streaming: true })
  expect(visible('.mermaid__source')).toBe(true)
  expect($('.mermaid__problem')).toBeNull()
  draw(fence('flowchart LR\n  a --> b'), { streaming: true })
  expect(visible('.mermaid__diagram svg')).toBe(true)
  const before = $('.mermaid__diagram')!.innerHTML
  // Half a line more: the diagram stays as it was, undimmed, with no error.
  draw(fence('flowchart LR\n  a --> b\n  b -->|'), { streaming: true })
  expect(visible('.mermaid__diagram svg')).toBe(true)
  expect($('.mermaid__diagram')!.innerHTML).toBe(before)
  expect($('.mermaid__problem')).toBeNull()
  expect($('.pele-error')).toBeNull()
  draw(fence('flowchart LR\n  a --> b\n  b -->|done| c'), { streaming: true })
  expect($('.mermaid__diagram')!.textContent).toContain('done')
})

it('shows source that still will not draw once the message is done, with a plain line saying why', () => {
  registry = createRegistry(app, [mermaid], () => {})
  draw(fence('flowchart LR\n  a --> b\n  b -->|'), { streaming: true })
  draw(fence('flowchart LR\n  a --> b\n  b -->|'))
  expect(visible('.mermaid__diagram')).toBe(false)
  expect($('.mermaid__source code')!.textContent).toBe('flowchart LR\n  a --> b\n  b -->|')
  const problem = $('.mermaid__problem')!
  expect(problem.textContent).toMatch(/^Could not render diagram: Parse error on line 3: Expecting .*, got '\$end'$/)
  expect(problem.children).toHaveLength(0)
  // Nothing to toggle to; the source still copies.
  expect($('[aria-label="Show diagram"]')).toBeNull()
  expect($('[aria-label="Copy source"]')).not.toBeNull()

  // A diagram type Pele doesn't know, with markup in it: said as text, never drawn as HTML.
  act(() => root!.unmount())
  root = undefined
  draw(fence('<img src=x onerror=alert(1)> nonsense'))
  expect($('.mermaid__problem')!.textContent).toContain('Could not render diagram:')
  expect($('.mermaid img')).toBeNull()
})

it('draws the block as code for a thread that goes without mermaid, and with no extension at all', () => {
  registry = createRegistry(app, [mermaid], () => {})
  draw(fence(FLOW), { thread: thread({ without: ['mermaid'] }) })
  expect($('.mermaid')).toBeNull()
  expect($('.md__code pre code.language-mermaid')!.textContent).toBe(`${FLOW}\n`)
  act(() => root!.unmount())
  root = undefined
  registry.teardown()
  registry = createRegistry(app, [], () => {})
  draw(fence(FLOW))
  expect($('.mermaid')).toBeNull()
  expect($('.md__code')).not.toBeNull()
})

it('lets go of the diagram when it goes', () => {
  registry = createRegistry(app, [mermaid], () => {})
  draw(fence(FLOW))
  expect($('.mermaid svg')).not.toBeNull()
  draw('No diagram now.')
  expect($('.mermaid')).toBeNull()
})

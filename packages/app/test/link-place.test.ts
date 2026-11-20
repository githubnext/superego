// @vitest-environment happy-dom
// useLinkPlace: how a transcript's or a file's links open the files they name, against a fake `file.find`: the file
// beside first, else by name; `:line` and `#L` kept; why not, when it can't; and the pane it opens, with its source.
// Code that names a path, against a fake `file.locate`: a link only once the thread's machine has the file, opened there.
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { createRegistry, RegistryProvider, type Registry } from '../src/renderer/registry.tsx'
import { LinkPlace, registerLinks, useLinkPlace, type LinkPlaceValue } from '../src/renderer/links.tsx'
import { Markdown } from '../src/renderer/Markdown.tsx'
import { forgetKnownFiles } from '../src/renderer/known-files.ts'
import type { MachineEntry } from '../src/shared/bridge.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Found = { path: string | null; folder?: boolean; line?: number }
const app = defineApp({ name: 'superego', id: 'superego' })
const thread: ThreadInfo = { id: 't1', title: 't', cwd: '/home/me/work', createdAt: 0, activeAt: 0, project: { root: '/home/me/work', name: 'work' }, status: { state: 'idle' } }
const View = () => null

const local: MachineEntry = { id: 'local', label: 'This computer', state: 'connected', features: ['file-locate'] }
const workbox: MachineEntry = { id: 'wb', label: 'workbox', state: 'connected', features: ['file-locate'], remote: { route: 'ssh workbox', enabled: true, ssh: true } }

/** What `file.find` was asked, and its answers by name; what `file.locate` was asked, of which machine, and its files there. */
let asked: string[]
let files: Record<string, Found>
let located: { machine: string; names: string[] }[]
let onDisk: Record<string, Record<string, { path: string; folder?: boolean; line?: number }>>
let opened: { id: string; params: unknown; options: unknown }[]
beforeEach(() => {
  asked = []
  files = {}
  located = []
  onDisk = {}
  opened = []
  forgetKnownFiles()
  window.superego = {
    call: async (machine: string, method: string, params: { name: string; names: string[] }) => {
      if (method === 'file.locate') {
        located.push({ machine, names: params.names })
        return { found: params.names.map((name) => onDisk[machine]?.[name] ?? null) }
      }
      if (method !== 'file.find') throw new Error(`unexpected ${method}`)
      asked.push(params.name)
      return files[params.name] ?? { path: null }
    },
    onEvent: () => () => {},
  } as never
})

function registry({ editor = true, folders = true } = {}): Registry {
  const r = createRegistry(app, [], (core) => {
    registerLinks(core)
    if (editor) core.pane('editor', { title: 'Editor', component: View, fallback: true })
    if (folders) core.pane('files', { title: 'Files', component: View, folders: true })
  })
  vi.spyOn(r.router, 'dispatch').mockImplementation(async (id, params, options) => { opened.push({ id, params, options }); return undefined })
  return r
}

let place: LinkPlaceValue
function Probe({ near, source, machine = local, text }: { near?: string; source: string; machine?: MachineEntry; text?: string }) {
  place = useLinkPlace(machine, thread, { near, source })
  return text === undefined ? null : h(LinkPlace.Provider, { value: place }, h(Markdown, { text }))
}
let unmount: (() => Promise<void>) | undefined
afterEach(async () => { await unmount?.(); unmount = undefined })
let element: HTMLElement
async function mount(r: Registry, props: { near?: string; source: string; machine?: MachineEntry; text?: string }) {
  element = document.createElement('div')
  const root = createRoot(element)
  await act(() => root.render(h(RegistryProvider, { registry: r, children: h(Probe, props) })))
  unmount = () => act(async () => root.unmount())
}
/** Once what the machine was asked has come back, and the text is drawn again. */
const answered = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)) })
const links = () => [...element.querySelectorAll('a.md__file')].map((a) => a.textContent)
const open = (name: string) => place.openFile!(name)

it("opens a file's link beside it first, with its line, and says where it came from", async () => {
  files['docs/b.md:12'] = { path: 'docs/b.md', line: 12 }
  await mount(registry(), { near: 'docs/', source: 'editor' })
  expect(await open('b.md:12')).toBeUndefined()
  expect(asked).toEqual(['docs/b.md:12'])
  expect(opened).toEqual([{ id: 'pane.open', params: { thread: 't1', kind: 'editor', params: { path: 'docs/b.md', line: 12 } }, options: { machine: 'local', source: 'editor' } }])
})

it('takes a note named without .md beside it, and keeps a #L suffix', async () => {
  files['docs/plan#L3'] = { path: 'docs/plan.md', line: 3 }
  await mount(registry(), { near: 'docs/', source: 'editor' })
  expect(await open('plan#L3')).toBeUndefined()
  expect(asked).toEqual(['docs/plan#L3'])
  expect(opened[0]!.params).toEqual({ thread: 't1', kind: 'editor', params: { path: 'docs/plan.md', line: 3 } })
})

it('falls back to the name when nothing is beside it, as a transcript always does', async () => {
  files['b.md'] = { path: 'src/b.md' }
  await mount(registry(), { near: 'docs/', source: 'editor' })
  expect(await open('b.md')).toBeUndefined()
  expect(asked).toEqual(['docs/b.md', 'b.md'])
  expect(opened[0]!.params).toEqual({ thread: 't1', kind: 'editor', params: { path: 'src/b.md' } })

  asked = []
  opened = []
  await unmount!()
  await mount(registry(), { source: 'thread' })
  expect(await open('b.md')).toBeUndefined()
  expect(asked).toEqual(['b.md'])
  expect(opened[0]!.options).toEqual({ machine: 'local', source: 'thread' })
})

it('opens a folder where folders show', async () => {
  files.src = { path: 'src', folder: true }
  await mount(registry(), { source: 'thread' })
  expect(await open('src')).toBeUndefined()
  expect(opened[0]!.params).toEqual({ thread: 't1', kind: 'files', params: { path: 'src' } })
})

it('opens a file outside the thread\'s folder', async () => {
  files['~/notes/draft.md'] = { path: '/home/me/notes/draft.md' }
  await mount(registry(), { source: 'thread' })
  expect(await open('~/notes/draft.md')).toBeUndefined()
  expect(opened[0]!.params).toEqual({ thread: 't1', kind: 'editor', params: { path: '/home/me/notes/draft.md' } })
})

it("says why it can't: not there, or nothing here shows it", async () => {
  files['f.md'] = { path: 'f.md' }
  files.src = { path: 'src', folder: true }
  await mount(registry({ editor: false, folders: false }), { source: 'thread' })
  expect(await open('gone.md')).toBe('not in ~/work')
  expect(await open('/tmp/gone.md')).toBe('not found')
  expect(await open('f.md')).toBe('a file, and nothing here shows files')
  expect(await open('src')).toBe('a folder, and nothing here shows folders')
  expect(opened).toEqual([])
})

it('links code to an untracked or ignored file once its machine says it is there, and opens it there', async () => {
  onDisk.wb = { 'scripts/product-shape.md': { path: 'scripts/product-shape.md' } }
  await mount(registry(), { source: 'thread', machine: workbox, text: 'I wrote `scripts/product-shape.md`; also `scripts/gone.md` and `npm test`.' })
  await answered()
  // Asked once, for both, of the thread's machine.
  expect(located).toEqual([{ machine: 'wb', names: ['scripts/product-shape.md', 'scripts/gone.md'] }])
  expect(links()).toEqual(['scripts/product-shape.md'])
  // A missing file stays plain code, with nothing of a link about it.
  const gone = [...element.querySelectorAll('code')].find((code) => code.textContent === 'scripts/gone.md')!
  expect(gone.closest('a')).toBeNull()

  await act(async () => { element.querySelector<HTMLAnchorElement>('a.md__file')!.click() })
  await answered()
  expect(located.at(-1)).toEqual({ machine: 'wb', names: ['scripts/product-shape.md'] })
  expect(opened).toEqual([{ id: 'pane.open', params: { thread: 't1', kind: 'editor', params: { path: 'scripts/product-shape.md' } }, options: { machine: 'wb', source: 'thread' } }])
  expect(asked).toEqual([])
})

it('says why, on the link, when a file it linked has gone by the time it is clicked', async () => {
  onDisk.local = { 'notes.md': { path: 'notes.md' } }
  await mount(registry(), { source: 'thread', text: 'see `notes.md`' })
  await answered()
  const link = element.querySelector<HTMLAnchorElement>('a.md__file')!
  delete onDisk.local['notes.md']
  await act(async () => { link.click() })
  await answered()
  expect(opened).toEqual([])
  expect(link.classList.contains('md__file--missing')).toBe(true)
  expect(link.title).toBe('notes.md: no longer in ~/work')
})

it("leaves code as code on a machine that can't say what's there", async () => {
  onDisk.old = { 'notes.md': { path: 'notes.md' } }
  await mount(registry(), { source: 'thread', machine: { id: 'old', label: 'old', state: 'connected', features: [] }, text: 'see `notes.md`' })
  await answered()
  expect(located).toEqual([])
  expect(links()).toEqual([])
})

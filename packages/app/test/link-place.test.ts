// @vitest-environment happy-dom
// useLinkPlace: how a transcript's or a file's links open the files they name, against a fake `file.find`: the file
// beside first, else by name; `:line` and `#L` kept; why not, when it can't; and the pane it opens, with its source.
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineApp, type ThreadInfo } from '@superego/protocol'
import { createRegistry, RegistryProvider, type Registry } from '../src/renderer/extension.tsx'
import { useLinkPlace, type LinkPlaceValue } from '../src/renderer/links.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Found = { path: string | null; folder?: boolean; line?: number; outside?: boolean }
const app = defineApp({ name: 'superego', id: 'superego' })
const thread: ThreadInfo = { id: 't1', title: 't', cwd: '/home/me/work', createdAt: 0, activeAt: 0, project: { root: '/home/me/work', name: 'work' }, status: { state: 'idle' } }
const View = () => null

/** What `file.find` was asked, and its answers by name. */
let asked: string[]
let files: Record<string, Found>
let opened: { id: string; params: unknown; options: unknown }[]
beforeEach(() => {
  asked = []
  files = {}
  opened = []
  window.superego = {
    call: async (_machine: string, method: string, params: { name: string }) => {
      if (method !== 'file.find') throw new Error(`unexpected ${method}`)
      asked.push(params.name)
      return files[params.name] ?? { path: null }
    },
    onEvent: () => () => {},
  } as never
})

function registry({ editor = true, folders = true } = {}): Registry {
  const r = createRegistry(app, [], (core) => {
    if (editor) core.pane('editor', { title: 'Editor', component: View, fallback: true })
    if (folders) core.pane('files', { title: 'Files', component: View, folders: true })
  })
  vi.spyOn(r.router, 'dispatch').mockImplementation(async (id, params, options) => { opened.push({ id, params, options }); return undefined })
  return r
}

let place: LinkPlaceValue
function Probe({ near, source }: { near?: string; source: string }) {
  place = useLinkPlace('local', thread, { near, source })
  return null
}
let unmount: (() => Promise<void>) | undefined
afterEach(async () => { await unmount?.(); unmount = undefined })
async function mount(r: Registry, props: { near?: string; source: string }) {
  const root = createRoot(document.createElement('div'))
  await act(() => root.render(h(RegistryProvider, { registry: r, children: h(Probe, props) })))
  unmount = () => act(async () => root.unmount())
}
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

it("says why it can't: outside the thread's folder, not there, or nothing here shows it", async () => {
  files['../x.md'] = { path: null, outside: true }
  files['f.md'] = { path: 'f.md' }
  files.src = { path: 'src', folder: true }
  await mount(registry({ editor: false, folders: false }), { source: 'thread' })
  expect(await open('../x.md')).toBe('outside ~/work, where this thread works')
  expect(await open('gone.md')).toBe('not in ~/work')
  expect(await open('f.md')).toBe('a file, and nothing here shows files')
  expect(await open('src')).toBe('a folder, and nothing here shows folders')
  expect(opened).toEqual([])
})

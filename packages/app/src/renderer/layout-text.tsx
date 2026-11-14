// The layout as text, in the window: Edit layout… (⌘K, Settings) opens `layout.json` (see main/layout-file.ts) beside the
// thread shown when it's on this computer, else in the file's own app; the views declared are told to the file, which
// lists them and checks layouts against them; and what's wrong with the file as last saved is noted, in the title bar
// (or the sidebar's foot) and in the file's editor, with the views it names that aren't here now. A browser keeps its
// layout itself: there, Edit layout… opens it in a dialog.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SettingsSnapshot } from '@superego/protocol'
import { Button, Dialog, TextArea } from '@superego/ui'
import { useAppSetting, useSettings, watched } from './client.ts'
import { isLayout, LAYOUT, PLACES, type Place, type Placement } from './layout.ts'
import { defineWindowAction } from './actions.tsx'
import { useRegistry, type EditorSlotProps, type UiApi } from './extension.tsx'

type LayoutData = { file: string; problem?: string; missing?: string[] }

const dataOf = (snapshot: SettingsSnapshot | undefined) => snapshot?.sections.find((s) => s.id === 'layout')?.data as LayoutData | undefined

export function registerLayoutText(core: UiApi) {
  core.action(defineWindowAction({
    id: 'layout.edit', title: 'Edit layout…',
    async run(_params, c) {
      if (window.superego.web) return editing.set(true)
      const file = dataOf(watched<SettingsSnapshot>('app', 'settings.watch', {}))?.file
      if (file && c.selection?.machine === 'local') {
        await c.dispatch('pane.open', { id: c.selection.thread, kind: 'editor', params: { path: file } }, { machine: 'local', source: 'layout' })
      } else await c.dispatch('app.layout.open', {}, { machine: 'app', source: 'layout' })
    },
  }))
  core.slot('editor.bar', LayoutFileNote)
}

/** What's wrong with the layout file, if anything. */
const useLayoutData = () => window.superego.web ? undefined : dataOf(useSettings('app', true))

/** Tell the layout file the views there are, as they come and go. */
export function LayoutViews() {
  const registry = useRegistry()
  // One entry an id, as the layout keeps it: declared in several scopes (a profile's on two machines), it fits where
  // any of them does, and goes by default where the first says.
  const views = new Map<string, { id: string; title: string; fits: Place[]; default?: Placement; narrow?: Placement }>()
  for (const { id, title, fits, default: initial, narrow } of registry.views) {
    const had = views.get(id)
    if (had) had.fits = PLACES.filter((p) => had.fits.includes(p) || fits.includes(p))
    else views.set(id, { id, title, fits, ...(initial !== undefined ? { default: initial } : {}), ...(narrow !== undefined ? { narrow } : {}) })
  }
  const key = JSON.stringify([...views.values()])
  useEffect(() => {
    if (window.superego.web) return
    const timer = setTimeout(() => void registry.router.dispatch('app.layout.views', { views: [...views.values()] }, { machine: 'app', source: 'layout' }).catch(() => {}), 500)
    return () => clearTimeout(timer)
  }, [key])
  return null
}

/** In the window: the layout file wasn't applied, and a way to it. */
export function LayoutNotice() {
  const data = useLayoutData()
  const dispatch = useRegistry().router.dispatch
  if (!data?.problem) return null
  return (
    <div className="service-notice is-deferred layout-notice" role="status">
      <Button title={data.problem} onClick={() => void dispatch('layout.edit', {}, { source: 'notice' }).catch((error) => console.error(error))}>Layout not applied…</Button>
    </div>
  )
}

/** In the layout file's editor: what's wrong with it as saved, in full. */
function LayoutFileNote({ path }: EditorSlotProps) {
  const data = useLayoutData()
  if (!data || path !== data.file) return null
  return data.problem
    ? <span className="layout-note is-problem" role="status">Not applied, the last good layout stays: {data.problem}</span>
    : <span className="layout-note">Applied as you save{data.missing ? `; not here now, kept for when they're back: ${data.missing.join(', ')}` : ''}</span>
}

/** Whether a browser's layout dialog is open. */
const editing = (() => {
  let open = false
  const listeners = new Set<() => void>()
  return {
    get: () => open,
    set(next: boolean) { open = next; for (const listener of listeners) listener() },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
})()

/** What's wrong with `text` as a layout, if anything; else the layout. */
function readLayout(text: string): { layout: object } | { problem: string } {
  let value: unknown
  try { value = text.trim() ? JSON.parse(text) : {} } catch (error) { return { problem: `Not JSON: ${(error as Error).message}` } }
  if (!isLayout(value as never)) return { problem: 'Not a layout: an object of "place", "order" and "narrow", with view ids and place names' }
  const layout = value as { place?: Record<string, unknown>; order?: Record<string, unknown>; narrow?: { place?: Record<string, unknown>; order?: Record<string, unknown> } }
  const named = [layout, layout.narrow ?? {}].flatMap((l) => [...Object.values(l.place ?? {}).flat(), ...Object.keys(l.order ?? {})]).filter((p): p is string => typeof p === 'string')
  const unknown = named.filter((p) => !(PLACES as string[]).includes(p))
  return unknown.length ? { problem: `No place ${unknown.map((p) => `"${p}"`).join(', ')}` } : { layout: layout as object }
}

/** In a browser, the layout as text in a dialog: saved, it applies; a mistake is said, and nothing changes. */
export function LayoutEditor() {
  const open = useSyncExternalStore(editing.subscribe, editing.get)
  return open ? <LayoutDialog onClose={() => editing.set(false)} /> : null
}

function LayoutDialog({ onClose }: { onClose(): void }) {
  const [stored] = useAppSetting(LAYOUT)
  const dispatch = useRegistry().router.dispatch
  const [text, setText] = useState(() => JSON.stringify(stored ?? {}, null, 2))
  const [problem, setProblem] = useState<string>()
  const save = () => {
    const read = readLayout(text)
    if ('problem' in read) return setProblem(read.problem)
    dispatch('app.settings.set', { key: LAYOUT, value: read.layout as never }, { machine: 'app', source: 'layout' }).then(onClose, (error: Error) => setProblem(error.message))
  }
  return (
    <Dialog title="Layout" size="medium" onClose={onClose} className="layout-editor">
      <TextArea className="layout-editor__text" aria-label="Layout" value={text} maxRows={20} spellCheck={false} onChange={(e) => { setText(e.target.value); setProblem(undefined) }} />
      {problem && <div className="layout-note is-problem" role="status">{problem}</div>}
      <div className="layout-editor__actions"><Button variant="primary" onClick={save}>Save</Button></div>
    </Dialog>
  )
}

// The layout as text, in the window: Edit layout… (⌘K, Settings) opens `layout.json` (see main/layout-file.ts) beside the
// thread shown when it's on this computer, else in the file's own app; the views declared are told to the file, which
// lists them and checks layouts against them; and what's wrong with the file as last saved is noted, in the title bar
// (or the sidebar's foot) and in the file's editor, with the views it names that aren't here now. A browser keeps its
// layout itself: there, Edit layout… opens it in a dialog.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SettingsSnapshot } from '@superego/protocol'
import { Button, Dialog, TextArea, WarningIcon } from '@superego/ui'
import { useAppSetting, useSettings, watched } from './client.ts'
import { APP, LAYOUT } from '../shared/app-settings.ts'
import { parseLayout, PLACES, type LayoutView } from '../shared/layout.ts'
import { defineWindowAction } from './actions.tsx'
import { useRegistry, type EditorSlotProps, type Registry, type UiApi } from './extension.tsx'
import { RailNotice } from './rail-notice.tsx'

type LayoutData = { file: string; problem?: string; missing?: string[] }

const dataOf = (snapshot: SettingsSnapshot | undefined) => snapshot?.sections.find((s) => s.id === 'layout')?.data as LayoutData | undefined

export function registerLayoutText(core: UiApi) {
  core.action(defineWindowAction({
    id: 'layout.edit', title: 'Edit layout…',
    async run(_params, c) {
      if (window.superego.web) return editing.set(true)
      const file = dataOf(watched<SettingsSnapshot>(APP, 'settings.watch', {}))?.file
      if (file && c.selection?.machine === 'local') {
        await c.dispatch('pane.open', { thread: c.selection.thread, kind: 'editor', params: { path: file } }, { machine: 'local', source: 'layout' })
      } else await c.dispatch('app.layout.open', {}, { machine: APP, source: 'layout' })
    },
  }))
  core.slot('editor.bar', LayoutFileNote)
}

/** What's wrong with the layout file, if anything. */
const useLayoutData = () => window.superego.web ? undefined : dataOf(useSettings(APP, true))

/**
 * The window's views, as the layout knows them: one entry an id. Declared in several scopes (a profile's on two
 * machines), it fits where any of them does, and goes by default where the first says.
 */
function layoutViews(declared: Registry['views']): LayoutView[] {
  const views = new Map<string, LayoutView>()
  for (const { id, title, fits, default: initial, narrow } of declared) {
    const had = views.get(id)
    if (had) had.fits = PLACES.filter((p) => had.fits.includes(p) || fits.includes(p))
    else views.set(id, { id, title, fits, ...(initial !== undefined ? { default: initial } : {}), ...(narrow !== undefined ? { narrow } : {}) })
  }
  return [...views.values()]
}

/** Tell the layout file the views there are, as they come and go. */
export function LayoutViews() {
  const registry = useRegistry()
  const views = layoutViews(registry.views)
  const key = JSON.stringify(views)
  useEffect(() => {
    if (window.superego.web) return
    const timer = setTimeout(() => void registry.router.dispatch('app.layout.views', { views }, { machine: APP, source: 'layout' }).catch(() => {}), 500)
    return () => clearTimeout(timer)
  }, [key])
  return null
}

/** In the window: the layout file wasn't applied, and a way to it. */
export function LayoutNotice({ rail = false }: { rail?: boolean }) {
  const data = useLayoutData()
  const dispatch = useRegistry().router.dispatch
  if (!data?.problem) return null
  const edit = () => void dispatch('layout.edit', {}, { source: 'notice' }).catch((error) => console.error(error))
  if (rail) {
    return (
      <RailNotice kind="layout" label="Layout not applied" tone="blocked" icon={WarningIcon}>
        <div className="service-notice layout-notice" role="status">
          <div className="service-notice__label">Layout not applied</div>
          <div className="service-notice__detail">{data.problem}</div>
          <div className="service-notice__actions"><Button variant="primary" onClick={edit}>Edit layout…</Button></div>
        </div>
      </RailNotice>
    )
  }
  return (
    <div className="service-notice is-deferred layout-notice" role="status">
      <Button title={data.problem} onClick={edit}>Layout not applied…</Button>
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

/** In a browser, the layout as text in a dialog: saved, it applies; a mistake is said, and nothing changes. */
export function LayoutEditor() {
  const open = useSyncExternalStore(editing.subscribe, editing.get)
  return open ? <LayoutDialog onClose={() => editing.set(false)} /> : null
}

function LayoutDialog({ onClose }: { onClose(): void }) {
  const [stored] = useAppSetting(LAYOUT)
  const registry = useRegistry()
  const [text, setText] = useState(() => JSON.stringify(stored ?? {}, null, 2))
  const [problem, setProblem] = useState<string>()
  const save = () => {
    const read = parseLayout(text, layoutViews(registry.views))
    if ('problem' in read) return setProblem(read.problem)
    registry.router.dispatch('app.settings.set', { key: LAYOUT, value: read.layout }, { machine: APP, source: 'layout' }).then(onClose, (error: Error) => setProblem(error.message))
  }
  return (
    <Dialog title="Layout" size="medium" onClose={onClose} className="layout-editor">
      <TextArea className="layout-editor__text" aria-label="Layout" value={text} maxRows={20} spellCheck={false} onChange={(e) => { setText(e.target.value); setProblem(undefined) }} />
      {problem && <div className="layout-note is-problem" role="status">{problem}</div>}
      <div className="layout-editor__actions"><Button variant="primary" onClick={save}>Save</Button></div>
    </Dialog>
  )
}

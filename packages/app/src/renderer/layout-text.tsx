// The layout as text, in the window: Edit layout… (⌘K) opens `layout.json` (see main/layout-file.ts) beside the thread
// shown when it's on this computer, else in the file's own app; the views declared are told to the file, which lists them
// and checks layouts against them; and what's wrong with the file as last saved is noted, in the title bar (or the
// sidebar's foot) and in the file's editor. The desktop app's only: a browser keeps its layout itself.
import { useEffect } from 'react'
import type { SettingsSnapshot } from '@superego/protocol'
import { Button } from '@superego/ui'
import { useSettings, watched } from './client.ts'
import { defineWindowAction } from './actions.tsx'
import { useRegistry, type EditorSlotProps, type UiApi } from './extension.tsx'

type LayoutData = { file: string; problem?: string }

const dataOf = (snapshot: SettingsSnapshot | undefined) => snapshot?.sections.find((s) => s.id === 'layout')?.data as LayoutData | undefined

export function registerLayoutText(core: UiApi) {
  core.action(defineWindowAction({
    id: 'layout.edit', title: 'Edit layout…',
    when: () => !window.superego.web,
    async run(_params, c) {
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
  const views = new Map(registry.views.map(({ id, title, fits, default: initial, narrow }) => [id, {
    id, title, fits, ...(initial !== undefined ? { default: initial } : {}), ...(narrow !== undefined ? { narrow } : {}),
  }]))
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
    : <span className="layout-note">Applied as you save</span>
}

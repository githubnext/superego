// web-panes, UI half: Preview, a web page beside the thread (a link it names, opened beside; the agent's pane_open
// "preview"), and Artifact, an HTML file the agent wrote, shown as a page. Both reload from their header; an artifact
// also whenever the thread moves on, as it may have rewritten it. A preview of `localhost` on another machine than this
// computer loads from that machine's, forwarded here by the app (the bridge's `forward`).
import { useEffect, useState } from 'react'
import { defineUiExtension, PaneButton, PaneHeader, PaneMessage, PaneNote, type PaneProps } from '@superego/app/ui'
import type { Pane } from '@superego/protocol'
import { FileTextIcon, GlobeIcon } from '@superego/ui'
import './styles.css'
import { about, ARTIFACT, PREVIEW } from './shared.ts'

const params = <T,>(pane: Pane) => (pane.params ?? {}) as T
/** The file a pane shows, by name: its tab's title. */
const fileName = (pane: Pane) => params<{ path?: string }>(pane).path?.split('/').at(-1)

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(PREVIEW, { title: 'Preview', icon: GlobeIcon, component: PreviewPane, urls: true, width: 0.6 })
    superego.pane(ARTIFACT, { title: (pane) => fileName(pane) ?? 'Artifact', icon: FileTextIcon, file: true, component: ArtifactPane })
  },
})

/** A web page: a dev server (the thread's machine's `localhost`, forwarded here when that's another computer), docs. */
function PreviewPane({ machine, pane }: PaneProps) {
  const { url } = params<{ url?: string }>(pane)
  const [key, setKey] = useState(0)
  const valid = Boolean(url && /^https?:\/\//.test(url))
  const [shown, setShown] = useState<{ for: string; url?: string; error?: string }>()
  useEffect(() => {
    if (!url || !valid) return
    const forward = window.superego.forward
    if (!forward) {
      setShown({ for: url, url })
      return
    }
    let current = true
    forward(machine.id, url).then((at) => { if (current) setShown({ for: url, url: at }) }, (error: Error) => {
      console.error(`Preview of ${url} on ${machine.label}:`, error)
      if (current) setShown({ for: url, error: error.message })
    })
    return () => { current = false }
  }, [machine.id, machine.label, url, valid])
  if (!url || !valid) return <PaneMessage>No address (an http or https URL) given.</PaneMessage>
  if (shown?.for !== url) return <PaneMessage>Loading…</PaneMessage>
  if (shown.error) return <PaneMessage>{shown.error}</PaneMessage>
  const at = shown.url!
  // Forwarded at another port (the machine's is taken here): said, as its own links to that port lead elsewhere.
  const moved = at !== url && new URL(at).port !== new URL(url).port
  const note = moved ? `${url} (${machine.label}), here at ${new URL(at).host}` : url
  return (
    <div className="web-panes-frame">
      <PaneHeader><PaneNote title={note} href={at}>{note}</PaneNote><PaneButton onClick={() => setKey((k) => k + 1)}>Reload</PaneButton></PaneHeader>
      <iframe key={key} src={at} title={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  )
}

/** An HTML file the agent wrote, shown as a page: sandboxed, from its own origin, with its relative files beside it. */
function ArtifactPane({ machine, thread, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  const [key, setKey] = useState(0)
  useEffect(() => { setKey((k) => k + 1) }, [thread.activeAt])
  if (!path) return <PaneMessage>No file given.</PaneMessage>
  const url = window.superego.artifactUrl?.(machine.id, thread.id, path)
  if (!url) return <PaneMessage>Artifacts aren't shown here.</PaneMessage>
  return (
    <div className="web-panes-frame">
      <PaneHeader><PaneNote title={path} code>{path}</PaneNote><PaneButton onClick={() => setKey((k) => k + 1)}>Reload</PaneButton></PaneHeader>
      <iframe key={key} src={url} title={path} sandbox="allow-scripts allow-forms allow-popups" />
    </div>
  )
}

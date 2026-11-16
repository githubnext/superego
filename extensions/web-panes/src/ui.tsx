/// <reference path="./env.d.ts" />
// web-panes, UI half: Preview, a web page beside the thread (a link it names, opened beside; the agent's pane_open
// "preview"), and Artifact, an HTML file the agent wrote, shown as a page. Both reload from their header; an artifact
// also whenever the thread moves on, as it may have rewritten it.
import { useEffect, useState } from 'react'
import { defineUiExtension, PaneHeader, type PaneProps } from '@superego/app/ui'
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

/** A web page: a local dev server, docs. */
function PreviewPane({ pane }: PaneProps) {
  const { url } = params<{ url?: string }>(pane)
  const [key, setKey] = useState(0)
  if (!url || !/^https?:\/\//.test(url)) return <div className="pane-empty">No address (an http or https URL) given.</div>
  return (
    <div className="frame-pane">
      <PaneHeader><a className="pane-header__note pane-header__url" title={url} href={url} target="_blank" rel="noreferrer">{url}</a><button type="button" className="pane-header__button" onClick={() => setKey((k) => k + 1)}>Reload</button></PaneHeader>
      <iframe key={key} src={url} title={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  )
}

/** An HTML file the agent wrote, shown as a page: sandboxed, from its own origin, with its relative files beside it. */
function ArtifactPane({ machine, thread, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  const [key, setKey] = useState(0)
  useEffect(() => { setKey((k) => k + 1) }, [thread.activeAt])
  if (!path) return <div className="pane-empty">No file given.</div>
  const url = window.superego.artifactUrl?.(machine.id, thread.id, path)
  if (!url) return <div className="pane-empty">Artifacts aren't shown here.</div>
  return (
    <div className="frame-pane">
      <PaneHeader><code className="pane-header__note" title={path}>{path}</code><button type="button" className="pane-header__button" onClick={() => setKey((k) => k + 1)}>Reload</button></PaneHeader>
      <iframe key={key} src={url} title={path} sandbox="allow-scripts allow-forms allow-popups" />
    </div>
  )
}

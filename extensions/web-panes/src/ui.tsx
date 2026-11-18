// web-panes, UI half: Preview, a web page beside the thread (a link it names, opened beside; the agent's pane_open
// "preview"), and Artifact, an HTML file the agent wrote, shown as a page. On the desktop each is a page of its own over
// the pane, as a browser tab is (the app's WebView): its cookies hold, its redirects through other ports and sites
// work, its history goes back and forward. In a browser they're framed. Both reload from their header; an artifact also
// whenever its file has changed (looked at as the thread moves on). A preview of `localhost` on another machine than this
// computer loads from that machine's, forwarded here by the app (the bridge's `forward`).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { askText, call, defineUiExtension, hasWebViews, useApp, PaneMessage, thisComputer, WebView, type PaneProps, type PermissionAsk, type WebViewEvent, type WebViewHandle } from '@superego/app/ui'
import type { Pane } from '@superego/protocol'
import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, Button, FileTextIcon, GlobeIcon, IconButton, XIcon } from '@superego/ui'
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
  return <Page key={shown.url} url={url} at={shown.url!} machine={machine.label} />
}

/** What a page did that its pane tells of, until it's dismissed: a file it saved, something it was refused. */
type Notice = { text: string; path?: string }

/** The page at `at`, where `url` (on `machine`) loads from here. */
function Page({ url, at, machine }: { url: string; at: string; machine: string }) {
  const view = useRef<WebViewHandle>(null)
  const [state, setState] = useState<{ url: string; canGoBack: boolean; canGoForward: boolean; ask?: PermissionAsk }>()
  const [notice, setNotice] = useState<Notice>()
  const [waiting, setWaiting] = useState(false)
  const app = useApp()
  const onEvent = (event: WebViewEvent) => {
    if (event.type === 'state') setState(event.state)
    if (event.type === 'download' && event.state !== 'progressing') {
      setNotice(event.state === 'completed' ? { text: `Saved ${event.name} to Downloads`, path: event.path } : { text: `${event.name} wasn't saved (${event.state})` })
    }
    if (event.type === 'denied') setNotice({ text: `The page asked for ${PERMISSIONS[event.permission] ?? event.permission}: refused here` })
    if (event.type === 'blocked') setNotice({ text: `macOS doesn't let ${app.name} use the ${event.permission}: allow it in System Settings → Privacy & Security` })
  }
  // Forwarded from another machine: its address there is shown, with where it's come from, and where it is here when
  // that's at another port (the machine's is taken here), as the page's own links to that port lead elsewhere.
  const here = new URL(at)
  const current = state?.url || at
  const forwarded = at !== url && current.startsWith(here.origin)
  const address = forwarded ? new URL(url).origin + current.slice(here.origin.length) : current
  const moved = forwarded && here.port !== new URL(url).port
  const where = forwarded ? `${machine}${moved ? `, here at ${here.host}` : ''}` : undefined
  const native = hasWebViews()
  return (
    <div className="web-panes-frame">
      <div className="web-panes-toolbar">
        {native && <IconButton label="Back" variant="ghost" disabled={!state?.canGoBack} onClick={() => view.current?.go(-1)}><ArrowLeftIcon size={14} aria-hidden /></IconButton>}
        {native && <IconButton label="Forward" variant="ghost" disabled={!state?.canGoForward} onClick={() => view.current?.go(1)}><ArrowRightIcon size={14} aria-hidden /></IconButton>}
        <IconButton label="Reload" variant="ghost" onClick={() => view.current?.reload()}><ArrowClockwiseIcon size={14} aria-hidden /></IconButton>
        <Address title={where ? `${address} (${where})` : address} parts={urlParts(address)}>
          {where && <span className="web-panes-where">{where}</span>}
        </Address>
        {waiting && <ReturnHint />}
        <a className="superego-button superego-button--ghost superego-icon-button" href={current} target="_blank" rel="noreferrer" aria-label="Open in browser" title="Open in browser"><ArrowSquareOutIcon size={14} aria-hidden /></a>
      </div>
      {state?.ask && <Ask ask={state.ask} answer={(allow) => view.current?.answer(allow)} />}
      {notice && (
        <div className="web-panes-notice" role="status">
          <span>{notice.text}</span>
          {notice.path && <button type="button" onClick={() => view.current?.reveal(notice.path!)}>Show</button>}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}><XIcon size={11} aria-hidden /></button>
        </div>
      )}
      <WebView ref={view} src={at} partition="preview" title={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" onEvent={onEvent} onWaiting={setWaiting} />
    </div>
  )
}

/**
 * Where the page is, in a quiet pill: what says little (the scheme, `localhost`, a file's folder) faint, the rest as
 * text. A click selects all of it, to copy; `children` follow it, inside (where a forwarded page is from).
 */
function Address({ title, parts: [quiet, rest], children }: { title: string; parts: [string, string]; children?: ReactNode }) {
  return (
    <div className="web-panes-address" title={title}>
      <span className="web-panes-address__text"><span className="web-panes-address__quiet">{quiet}</span>{rest}</span>
      {children}
    </div>
  )
}

/** The hosts a dev server is at: said quietly, as they say nothing of which page it is. */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

/** A URL as the address shows it: the scheme (and a local host) quiet, the rest (another host, the path) as text. */
function urlParts(address: string): [string, string] {
  const match = /^([a-z][\w+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(address)
  if (!match) return ['', address]
  const [, scheme, host, path] = match as unknown as [string, string, string, string]
  return LOCAL.test(host) ? [scheme + host, path] : [scheme, host + path]
}

/** A file's path as the address shows it: its folder quiet, its name as text. */
const pathParts = (path: string): [string, string] => {
  const at = path.lastIndexOf('/') + 1
  return [path.slice(0, at), path.slice(at)]
}

/** What the page asks for, until the user answers: only they can, here. */
function Ask({ ask, answer }: { ask: PermissionAsk; answer(allow: boolean): void }) {
  const text = askText(ask, thisComputer(navigator.platform))
  return (
    <div className="web-panes-ask" role="group" aria-label={text}>
      <span title={ask.origin}>{text}</span>
      <Button variant="ghost" onClick={() => answer(false)}>Don't allow</Button>
      <Button onClick={() => answer(true)}>Allow</Button>
    </div>
  )
}

/** The pane has the keyboard, its page doesn't: Return passes it in. */
const ReturnHint = () => <span className="web-panes-hint">↩ to use the page</span>

/** What a page asks for, as the pane says it. */
const PERMISSIONS: Record<string, string> = {
  media: 'the camera or microphone', geolocation: 'your location', notifications: 'notifications', midi: 'MIDI devices', midiSysex: 'MIDI devices',
  'clipboard-read': 'the clipboard', fullscreen: 'the full screen', 'display-capture': 'the screen', pointerLock: 'the pointer', keyboardLock: 'the keyboard',
  'idle-detection': 'idle detection', 'storage-access': 'its storage elsewhere', 'top-level-storage-access': 'its storage elsewhere', hid: 'HID devices', serial: 'serial ports', usb: 'USB devices',
}

/** An HTML file the agent wrote, shown as a page: sandboxed, from its own origin, with its relative files beside it. */
function ArtifactPane({ machine, thread, pane }: PaneProps) {
  const { path } = params<{ path?: string }>(pane)
  const view = useRef<WebViewHandle>(null)
  const [waiting, setWaiting] = useState(false)
  const { revision, error } = useRevision(machine.id, thread, path)
  if (!path) return <PaneMessage>No file given.</PaneMessage>
  const url = window.superego.artifactUrl?.(machine.id, thread.id, path)
  if (!url) return <PaneMessage>Artifacts aren't shown here.</PaneMessage>
  return (
    <div className="web-panes-frame">
      <div className="web-panes-toolbar">
        <IconButton label="Reload" variant="ghost" onClick={() => view.current?.reload()}><ArrowClockwiseIcon size={14} aria-hidden /></IconButton>
        <Address title={path} parts={pathParts(path)} />
        {error && <span className="web-panes-hint" role="alert" title={error}>Won't reload as it changes: {error}</span>}
        {waiting && <ReturnHint />}
      </div>
      <WebView ref={view} src={url} partition="artifact" revision={revision} title={path} sandbox="allow-scripts allow-forms allow-popups" onWaiting={setWaiting} />
    </div>
  )
}

/**
 * The file's version (its time and size), looked at again whenever the thread moves on, as it may have rewritten it:
 * the page reloads when it's changed, and only then.
 */
function useRevision(machine: string, thread: PaneProps['thread'], path: string | undefined) {
  const [found, setFound] = useState<{ revision?: string; error?: string }>({})
  useEffect(() => {
    if (!path) return
    let current = true
    call<{ files: ({ mtimeMs: number; size: number } | null)[] }>(machine, 'file.stat', { thread: thread.id, paths: [path] }).then(({ files: [file] }) => {
      if (current) setFound({ revision: file ? `${file.mtimeMs}:${file.size}` : 'none' })
    }, (error: Error) => {
      console.error(`The artifact ${path}'s version:`, error)
      if (current) setFound({ error: error.message })
    })
    return () => { current = false }
  }, [machine, thread.id, path, thread.activeAt])
  return found
}

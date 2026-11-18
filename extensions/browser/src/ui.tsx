// browser, UI half: Browser, a page beside the thread, as a browser tab shows it. A web page (`{ url }`: a link the
// thread names, opened beside; a dev server; any site), an HTML file in the thread's folder (`{ path }`), or, opened
// from the pane menu or with ⌘T, a blank page with its address bar to type in. On the desktop each page is a view of
// its own over the pane (the app's WebView): its cookies hold, its redirects through other ports and sites work, its
// history goes back and forward. In a browser it's framed. A file's page reloads whenever the file has changed (looked
// at as the thread moves on). A web page at `localhost` on another machine than this computer loads from that machine's,
// forwarded here by the app (the bridge's `forward`).
//
// Its address bar: a quiet pill until it's clicked, then a field with the address selected. Return goes where it says (address.ts: a web address, a bare host, an HTML file's
// path, else a search), by pointing the pane there (`pane.update`), so the pane is where it was sent, for the agent and
// the next launch alike; Esc leaves it as it was.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { askText, call, defineAction, defineUiExtension, hasWebViews, PaneMessage, useApp, useAppSetting, useDispatch, thisComputer, WebView, type PaneProps, type PermissionAsk, type WebViewEvent, type WebViewHandle } from '@superego/app/ui'
import type { Pane } from '@superego/protocol'
import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, Button, GlobeIcon, IconButton, XIcon } from '@superego/ui'
import './styles.css'
import { about, BROWSER, type BrowserParams } from './shared.ts'
import { DEFAULT_SEARCH_ENGINE, destination, SEARCH_ENGINE, SEARCH_ENGINES, webAddress, type Destination, type SearchEngine } from './address.ts'

const params = (pane: Pane) => (pane.params ?? {}) as BrowserParams
/** The file a pane shows, by name: its tab's title. */
const fileName = (pane: Pane) => params(pane).path?.split('/').at(-1)

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(BROWSER, {
      title: (pane) => fileName(pane) ?? 'Browser', icon: GlobeIcon, file: (pane) => Boolean(params(pane).path),
      component: BrowserPane, urls: true, menu: true, width: 0.6,
    })
    superego.appSettings({
      id: 'browser', title: 'Browser', order: 62,
      settings: [{
        key: SEARCH_ENGINE, title: 'Search engine', default: DEFAULT_SEARCH_ENGINE, type: 'choice',
        options: Object.entries(SEARCH_ENGINES).map(([value, { label }]) => ({ value, label })),
      }],
    })
    // A blank page beside the thread shown, its address bar ready to type in.
    superego.action(defineAction({
      id: 'browser.new', title: 'New browser', keys: 'mod+t',
      when: (c) => Boolean(c.selection && c.threadOf(c.selection)),
      run: async (_p, c) => {
        if (!c.selection) return
        await c.dispatch('pane.open', { thread: c.selection.thread, kind: BROWSER }, { machine: c.selection.machine, source: 'browser' })
      },
    }))
  },
})

/** The page a pane shows: where it loads from here, with whose cookies; or why it can't. */
type Target = { src: string; partition: 'browser' | 'artifact'; revision?: string | undefined } | { message: string } | undefined

/** What a page did that its pane tells of, until it's dismissed: a file it saved, something it was refused. */
type Notice = { text: string; path?: string }

function BrowserPane({ machine, thread, pane }: PaneProps) {
  const { url: given, path } = params(pane)
  const url = given === undefined ? undefined : webAddress(given)
  const forwarded = useForwarded(machine, url)
  const { revision, error: revisionError } = useRevision(machine.id, thread, path)
  const artifact = path === undefined ? undefined : window.superego.artifactUrl?.(machine.id, thread.id, path)
  const target: Target =
    given !== undefined ? (!url ? { message: `Not a web address: ${given}` } : forwarded?.for !== url ? undefined : forwarded.error ? { message: forwarded.error } : { src: forwarded.at!, partition: 'browser' })
    : path !== undefined ? (artifact ? { src: artifact, partition: 'artifact', revision } : { message: "HTML files aren't shown here." })
    : undefined

  const view = useRef<WebViewHandle>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ url: string; canGoBack: boolean; canGoForward: boolean; ask?: PermissionAsk }>()
  const [notice, setNotice] = useState<Notice>()
  const [waiting, setWaiting] = useState(false)
  const [editing, setEditing] = useState(false)
  // Gone somewhere from the address bar: the page has the keyboard once it's there.
  const focusPage = useRef(false)
  const app = useApp()
  const dispatch = useDispatch()
  const [engine] = useAppSetting<SearchEngine>(SEARCH_ENGINE)
  const blank = given === undefined && path === undefined
  const src = target && 'src' in target ? target.src : undefined
  useEffect(() => {
    if (!src || !focusPage.current) return
    focusPage.current = false
    view.current?.focus()
  }, [src])

  const onEvent = (event: WebViewEvent) => {
    if (event.type === 'state') setState(event.state)
    if (event.type === 'download' && event.state !== 'progressing') {
      setNotice(event.state === 'completed' ? { text: `Saved ${event.name} to Downloads`, path: event.path } : { text: `${event.name} wasn't saved (${event.state})` })
    }
    if (event.type === 'denied') setNotice({ text: `The page asked for ${PERMISSIONS[event.permission] ?? event.permission}: refused here` })
    if (event.type === 'blocked') setNotice({ text: `macOS doesn't let ${app.name} use the ${event.permission}: allow it in System Settings → Privacy & Security` })
  }

  /** Where the page is, as the address bar says it: a web page's address (from its machine), or a file's path. */
  const current = state?.url || src
  const address = !current ? '' : url && src ? fromMachine(url, src, current) : artifact && path !== undefined ? fileAt(machine.id, thread.id, current) ?? current : current
  const where = url && src && src !== url && current?.startsWith(new URL(src).origin)
    ? `${machine.label}${new URL(src).port !== new URL(url).port ? `, here at ${new URL(src).host}` : ''}` : undefined

  const go = (to: Destination) => {
    focusPage.current = true
    // Where the pane points already (the page has moved on since, or the user wants it again): loaded there.
    if (('url' in to && to.url === url) || ('path' in to && to.path === path)) {
      focusPage.current = false
      if (src) view.current?.load(src)
      view.current?.focus()
      return
    }
    dispatch('pane.update', { thread: thread.id, pane: pane.id, params: to }, { machine: machine.id, source: 'browser' }).catch((error: Error) => {
      console.error(`Going to ${JSON.stringify(to)}:`, error)
      focusPage.current = false
      setNotice({ text: error.message })
    })
  }
  const native = hasWebViews()
  const isWeb = Boolean(current && /^https?:/i.test(current))
  return (
    <div ref={frame} className="browser-frame">
      <div className="browser-toolbar">
        {native && <IconButton label="Back" variant="ghost" disabled={!state?.canGoBack} onClick={() => view.current?.go(-1)}><ArrowLeftIcon size={14} aria-hidden /></IconButton>}
        {native && <IconButton label="Forward" variant="ghost" disabled={!state?.canGoForward} onClick={() => view.current?.go(1)}><ArrowRightIcon size={14} aria-hidden /></IconButton>}
        <IconButton label="Reload" variant="ghost" disabled={!src} onClick={() => view.current?.reload()}><ArrowClockwiseIcon size={14} aria-hidden /></IconButton>
        {editing || blank
          ? <AddressField address={address} blank={blank} onLeave={() => setEditing(false)}
              onCancel={() => {
                setEditing(false)
                // The pane keeps the keyboard, as it was before: Return passes it to the page.
                frame.current?.querySelector<HTMLElement>('.web-view')?.focus({ preventScroll: true })
              }}
              onGo={(text) => {
                const to = destination(text, engine ?? DEFAULT_SEARCH_ENGINE)
                if (!to) return
                setEditing(false)
                go(to)
              }} />
          : <Address title={where ? `${address} (${where})` : address} parts={url ? urlParts(address) : pathParts(address)} onEdit={() => setEditing(true)}>
              {where && <span className="browser-where">{where}</span>}
            </Address>}
        {revisionError && <span className="browser-hint" role="alert" title={revisionError}>Won't reload as it changes: {revisionError}</span>}
        {waiting && !editing && <ReturnHint />}
        {isWeb && <a className="superego-button superego-button--ghost superego-icon-button" href={current} target="_blank" rel="noreferrer" aria-label="Open in browser" title="Open in browser"><ArrowSquareOutIcon size={14} aria-hidden /></a>}
      </div>
      {state?.ask && <Ask ask={state.ask} answer={(allow) => view.current?.answer(allow)} />}
      {notice && (
        <div className="browser-notice" role="status">
          <span>{notice.text}</span>
          {notice.path && <button type="button" onClick={() => view.current?.reveal(notice.path!)}>Show</button>}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}><XIcon size={11} aria-hidden /></button>
        </div>
      )}
      {target && 'src' in target
        ? <WebView ref={view} src={target.src} partition={target.partition} revision={target.revision} title={url ?? path ?? 'Browser'}
            sandbox={target.partition === 'browser' ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-scripts allow-forms allow-popups'}
            onEvent={onEvent} onWaiting={setWaiting} />
        : !blank && <PaneMessage>{target?.message ?? 'Loading…'}</PaneMessage>}
    </div>
  )
}

/**
 * Where a web page at `url` on `machine` loads from here: as it is, or (`localhost` on another machine) forwarded here,
 * at the same port when it's free. Undefined while it's being found.
 */
function useForwarded(machine: PaneProps['machine'], url: string | undefined) {
  const [shown, setShown] = useState<{ for: string; at?: string; error?: string }>()
  useEffect(() => {
    if (!url) return
    const forward = window.superego.forward
    if (!forward) {
      setShown({ for: url, at: url })
      return
    }
    let current = true
    forward(machine.id, url).then((at) => { if (current) setShown({ for: url, at }) }, (error: Error) => {
      console.error(`${url} on ${machine.label}:`, error)
      if (current) setShown({ for: url, error: error.message })
    })
    return () => { current = false }
  }, [machine.id, machine.label, url])
  return shown
}

/**
 * A page's address as its machine has it: forwarded here from another machine, its address there (the page's own
 * links to its port lead elsewhere when the port moved, so where it is here is said beside it).
 */
function fromMachine(url: string, src: string, current: string) {
  const here = new URL(src).origin
  return src !== url && current.startsWith(here) ? new URL(url).origin + current.slice(here.length) : current
}

/** A page of the thread's folder by its path there, from its address; none for a page elsewhere. */
function fileAt(machine: string, thread: string, current: string) {
  const base = window.superego.artifactUrl?.(machine, thread, '')
  if (!base) return undefined
  const at = new URL(current, location.href).href
  const root = new URL(base, location.href).href
  if (!at.startsWith(root)) return undefined
  try { return at.slice(root.length).split(/[?#]/)[0]!.split('/').map(decodeURIComponent).join('/') } catch { return undefined }
}

/**
 * Where the page is, in a quiet pill: what says little (the scheme, `localhost`, a file's folder) faint, the rest as
 * text. A click makes it a field to type in; `children` follow it, inside (where a forwarded page is from).
 */
function Address({ title, parts: [quiet, rest], onEdit, children }: { title: string; parts: [string, string]; onEdit(): void; children?: ReactNode }) {
  return (
    <button type="button" className="browser-address" title={title} aria-label="Address" onClick={onEdit}>
      <span className="browser-address__text"><span className="browser-address__quiet">{quiet}</span>{rest}</span>
      {children}
    </button>
  )
}

/** The address bar being typed in: the address selected, Return to go, Esc (back to the pane) or leaving it to leave it as it was. */
function AddressField({ address, blank, onGo, onCancel, onLeave }: { address: string; blank: boolean; onGo(text: string): void; onCancel(): void; onLeave(): void }) {
  const [text, setText] = useState(address)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus({ preventScroll: true })
    input.current?.select()
  }, [])
  return (
    <input ref={input} className="browser-address browser-address--editing" aria-label="Address" placeholder="Search or type an address"
      spellCheck={false} autoCapitalize="off" autoCorrect="off" value={text} {...(blank ? { 'data-focus': '' } : {})}
      onChange={(event) => setText(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={() => { if (!blank) onLeave() }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          onGo(text)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (blank) setText('')
          else onCancel()
        }
      }} />
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

/** A file's path as the address shows it: its folder quiet, its name as text. A web page's (an HTML file's link out) as a URL. */
const pathParts = (path: string): [string, string] => {
  if (/^[a-z][\w+.-]*:/i.test(path)) return urlParts(path)
  const at = path.lastIndexOf('/') + 1
  return [path.slice(0, at), path.slice(at)]
}

/** What the page asks for, until the user answers: only they can, here. */
function Ask({ ask, answer }: { ask: PermissionAsk; answer(allow: boolean): void }) {
  const text = askText(ask, thisComputer(navigator.platform))
  return (
    <div className="browser-ask" role="group" aria-label={text}>
      <span title={ask.origin}>{text}</span>
      <Button variant="ghost" onClick={() => answer(false)}>Don't allow</Button>
      <Button onClick={() => answer(true)}>Allow</Button>
    </div>
  )
}

/** The pane has the keyboard, its page doesn't: Return passes it in. */
const ReturnHint = () => <span className="browser-hint">↩ to use the page</span>

/** What a page asks for, as the pane says it. */
const PERMISSIONS: Record<string, string> = {
  media: 'the camera or microphone', geolocation: 'your location', notifications: 'notifications', midi: 'MIDI devices', midiSysex: 'MIDI devices',
  'clipboard-read': 'the clipboard', fullscreen: 'the full screen', 'display-capture': 'the screen', pointerLock: 'the pointer', keyboardLock: 'the keyboard',
  'idle-detection': 'idle detection', 'storage-access': 'its storage elsewhere', 'top-level-storage-access': 'its storage elsewhere', hid: 'HID devices', serial: 'serial ports', usb: 'USB devices',
}

/**
 * The file's version (its time and size), looked at again whenever the thread moves on, as it may have rewritten it:
 * the page reloads when it's changed, and only then.
 */
function useRevision(machine: string, thread: PaneProps['thread'], path: string | undefined) {
  const [found, setFound] = useState<{ revision?: string; error?: string }>({})
  useEffect(() => {
    if (path === undefined) return setFound({})
    let current = true
    call<{ files: ({ mtimeMs: number; size: number } | null)[] }>(machine, 'file.stat', { thread: thread.id, paths: [path] }).then(({ files: [file] }) => {
      if (current) setFound({ revision: file ? `${file.mtimeMs}:${file.size}` : 'none' })
    }, (error: Error) => {
      console.error(`The page ${path}'s version:`, error)
      if (current) setFound({ error: error.message })
    })
    return () => { current = false }
  }, [machine, thread.id, path, thread.activeAt])
  return found
}

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
// the next launch alike; Esc leaves it as it was, and stops a page loading.
//
// While a page loads (LoadBar): a thin line in the accent along the toolbar's foot, easing toward 80% as it waits and
// ahead of that as the page's milestones come, full as it's done, then fading; a spinner in place of the globe on the
// pane's tab and in the address; Reload is Stop. None of it for a load done within SHOW_AFTER, so a quick one doesn't
// flash. A page that doesn't load says why, in its place (the app's WebView).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { askText, call, defineAction, defineUiExtension, hasWebViews, PaneMessage, useApp, useAppSetting, useDispatch, useTabGlyph, thisComputer, WebView, type PaneProps, type PermissionAsk, type WebViewEvent, type WebViewHandle } from '@superego/app/ui'
import type { Pane } from '@superego/protocol'
import { autoFocusOnOpen, ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, ArrowsOutLineHorizontalIcon, ArrowSquareOutIcon, Button, DeviceMobileIcon, DeviceTabletIcon, Glyph, GlobeIcon, IconButton, LaptopIcon, Menu, ResizeIcon, XIcon } from '@superego/ui'
import './styles.css'
import { about, BROWSER, type BrowserParams, type Viewport } from './shared.ts'
import { fit, isViewport, parseViewport, PRESETS, presetOf, viewportText, type Fit } from './viewport.ts'
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
  const { url: given, path, viewport: asked } = params(pane)
  const viewport = isViewport(asked) ? asked : undefined
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
  const [state, setState] = useState<{ url: string; loading: boolean; progress?: number; canGoBack: boolean; canGoForward: boolean; ask?: PermissionAsk }>()
  // Sent somewhere from here (Return, Back, Reload): loading from then, until the page says it is, or for STARTING if it
  // never does (where it went was refused, or the pane's still finding it).
  const [starting, setStarting] = useState(0)
  useEffect(() => {
    if (!starting) return
    const timer = setTimeout(() => setStarting(0), STARTING)
    return () => clearTimeout(timer)
  }, [starting])
  const begin = () => setStarting(Date.now())
  const loading = Boolean(starting) || Boolean(state?.loading)
  const shown = useShownLoad(loading)
  const busy = shown !== undefined && loading
  useTabGlyph(busy ? <Spinner /> : null, String(busy))
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
    if (event.type === 'state') {
      setState(event.state)
      if (event.state.loading) setStarting(0)
    }
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
      if (src) {
        begin()
        view.current?.load(src)
      }
      view.current?.focus()
      return
    }
    begin()
    dispatch('pane.update', { thread: thread.id, pane: pane.id, params: { ...to, ...(viewport ? { viewport } : {}) } }, { machine: machine.id, source: 'browser' }).catch((error: Error) => {
      console.error(`Going to ${JSON.stringify(to)}:`, error)
      focusPage.current = false
      setStarting(0)
      setNotice({ text: error.message })
    })
  }
  // The page's size, kept in the pane's params: it's the pane's, for the agent and the next launch alike.
  const resize = (next: Viewport | undefined) => {
    const { viewport: _was, ...rest } = params(pane)
    dispatch('pane.update', { thread: thread.id, pane: pane.id, params: { ...rest, ...(next ? { viewport: next } : {}) } }, { machine: machine.id, source: 'browser' }).catch((error: Error) => {
      console.error(`Showing the page at ${next ? viewportText(next) : 'full width'}:`, error)
      setNotice({ text: error.message })
    })
  }
  const stage = useRef<HTMLDivElement>(null)
  const fitted = fit(viewport, ...useSize(stage))
  const [sizing, setSizing] = useState(false)
  const stop = () => {
    setStarting(0)
    view.current?.stop()
  }
  const native = hasWebViews()
  const isWeb = Boolean(current && /^https?:/i.test(current))
  return (
    <div ref={frame} className="browser-frame" aria-busy={busy}>
      <div className="browser-toolbar">
        {native && <IconButton label="Back" variant="ghost" disabled={!state?.canGoBack} onClick={() => { begin(); view.current?.go(-1) }}><ArrowLeftIcon size={14} aria-hidden /></IconButton>}
        {native && <IconButton label="Forward" variant="ghost" disabled={!state?.canGoForward} onClick={() => { begin(); view.current?.go(1) }}><ArrowRightIcon size={14} aria-hidden /></IconButton>}
        {native && loading
          ? <IconButton label="Stop" variant="ghost" onClick={stop}><XIcon size={14} aria-hidden /></IconButton>
          : <IconButton label="Reload" variant="ghost" disabled={!src} onClick={() => { begin(); view.current?.reload() }}><ArrowClockwiseIcon size={14} aria-hidden /></IconButton>}
        {editing || blank
          ? <AddressField address={address} blank={blank} onLeave={() => setEditing(false)}
              onCancel={() => {
                if (loading) stop()
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
          : <Address title={where ? `${address} (${where})` : address} parts={url ? urlParts(address) : pathParts(address)} busy={busy} onEdit={() => setEditing(true)}>
              {where && <span className="browser-where">{where}</span>}
            </Address>}
        {revisionError && <span className="browser-hint" role="alert" title={revisionError}>Won't reload as it changes: {revisionError}</span>}
        {waiting && !editing && <ReturnHint />}
        {sizing
          ? <SizeField viewport={viewport} onDone={(next) => { setSizing(false); if (next) resize(next) }} />
          : <SizeMenu viewport={viewport} scale={fitted?.scale ?? 1} onPick={resize} onCustom={() => setSizing(true)} />}
        {isWeb && <a className="superego-button superego-button--ghost superego-icon-button" href={current} target="_blank" rel="noreferrer" aria-label="Open in browser" title="Open in browser"><ArrowSquareOutIcon size={14} aria-hidden /></a>}
        {shown !== undefined && <LoadBar key={shown} loading={loading} progress={state?.loading ? state.progress : undefined} />}
      </div>
      {state?.ask && <Ask ask={state.ask} answer={(allow) => view.current?.answer(allow)} />}
      {notice && (
        <div className="browser-notice" role="status">
          <span>{notice.text}</span>
          {notice.path && <button type="button" onClick={() => view.current?.reveal(notice.path!)}>Show</button>}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(undefined)}><XIcon size={11} aria-hidden /></button>
        </div>
      )}
      <div ref={stage} className={`browser-stage ${fitted ? 'is-sized' : ''}`}>
        {target && 'src' in target
          ? <div className="browser-page" style={fitted && pageStyle(fitted, viewport!)}>
              <WebView ref={view} src={target.src} partition={target.partition} revision={target.revision} title={url ?? path ?? 'Browser'}
                sandbox={target.partition === 'browser' ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-scripts allow-forms allow-popups'}
                onEvent={onEvent} onWaiting={setWaiting} sized={Boolean(fitted)} />
            </div>
          : !blank && <PaneMessage>{target?.message ?? 'Loading…'}</PaneMessage>}
      </div>
    </div>
  )
}

/** A page at a size, in its stage: its box there, scaled to fit; without a height of its own, as tall as the stage. */
const pageStyle = (fitted: Fit, viewport: Viewport) => ({
  width: fitted.width, height: viewport.height ?? `${100 / fitted.scale}%`, left: fitted.left, top: fitted.top,
  ...(fitted.scale < 1 ? { transform: `scale(${fitted.scale})` } : {}),
})

/** A box's inner size, as it changes. */
function useSize(ref: RefObject<HTMLElement | null>): [number, number] {
  const [size, setSize] = useState<[number, number]>([0, 0])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize((was) => was[0] === el.clientWidth && was[1] === el.clientHeight ? was : [el.clientWidth, el.clientHeight])
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

const PRESET_ICONS = { small: DeviceMobileIcon, medium: DeviceTabletIcon, large: LaptopIcon }

/** The page's size: an icon and its width (and, scaled to fit, by how much); a menu of the sizes to pick from. */
function SizeMenu({ viewport, scale, onPick, onCustom }: { viewport: Viewport | undefined; scale: number; onPick(viewport: Viewport | undefined): void; onCustom(): void }) {
  const preset = presetOf(viewport)
  const Icon = !viewport ? ArrowsOutLineHorizontalIcon : preset ? PRESET_ICONS[preset.id] : ResizeIcon
  const value = !viewport ? 'full' : preset?.id ?? 'custom'
  const percent = `${Math.round(scale * 100)}%`
  // Custom…: the field to type in takes the menu's place once it's closed, and the focus back.
  const custom = useRef(false)
  return (
    <Menu.Root onOpenChangeComplete={(open) => { if (!open && custom.current) { custom.current = false; onCustom() } }}>
      <Menu.Trigger className="browser-size" aria-label="Page size" title={viewport ? `${viewportText(viewport)}${scale < 1 ? `, at ${percent}` : ''}` : 'Full width'}>
        <Icon size={14} aria-hidden />
        {viewport && <span>{viewportText(viewport)}</span>}
        {viewport && scale < 1 && <span className="browser-size__scale">{percent}</span>}
      </Menu.Trigger>
      <Menu.Popup align="end">
        <Menu.RadioGroup value={value} onValueChange={(next: string) => {
          if (next === 'custom') return
          onPick(next === 'full' ? undefined : { width: PRESETS.find((p) => p.id === next)!.width })
        }}>
          {PRESETS.map((p) => <Menu.RadioItem key={p.id} value={p.id} hint={p.width} closeOnClick>{p.label}</Menu.RadioItem>)}
          <Menu.RadioItem value="full" closeOnClick>Full</Menu.RadioItem>
          {value === 'custom' && <Menu.RadioItem value="custom" hint={viewportText(viewport!)}>Custom</Menu.RadioItem>}
        </Menu.RadioGroup>
        <Menu.Separator />
        <Menu.Item onClick={() => { custom.current = true }}>Custom…</Menu.Item>
      </Menu.Popup>
    </Menu.Root>
  )
}

/** A size typed in, in the menu's place: Return sets it (if it is one), Esc or leaving it leaves the size as it was. */
function SizeField({ viewport, onDone }: { viewport: Viewport | undefined; onDone(viewport: Viewport | undefined): void }) {
  const [text, setText] = useState(viewport ? viewportText(viewport) : '')
  const [invalid, setInvalid] = useState(false)
  // Focused once the menu it came from has let go of the focus (it gives it back as it closes, to the trigger it was).
  const input = useRef<HTMLInputElement>(null)
  const focused = useRef(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus()
      focused.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <input ref={input} className="browser-address browser-address--editing browser-size-field" aria-label="Page size" placeholder="1024×768"
      spellCheck={false} autoCapitalize="off" autoCorrect="off" value={text} aria-invalid={invalid}
      onChange={(event) => { setText(event.target.value); setInvalid(false) }}
      onFocus={(event) => event.target.select()}
      onBlur={() => { if (focused.current) onDone(undefined) }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          const next = parseViewport(text)
          if (next) onDone(next)
          else setInvalid(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDone(undefined)
        }
      }} />
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
function Address({ title, parts: [quiet, rest], busy, onEdit, children }: { title: string; parts: [string, string]; busy: boolean; onEdit(): void; children?: ReactNode }) {
  return (
    <button type="button" className="browser-address" title={title} aria-label="Address" onClick={onEdit}>
      {busy ? <Spinner /> : <GlobeIcon className="browser-address__icon" size={14} aria-hidden />}
      <span className="browser-address__text"><span className="browser-address__quiet">{quiet}</span>{rest}</span>
      {children}
    </button>
  )
}

/** The address bar being typed in: the address selected, Return to go, Esc (back to the pane) or leaving it to leave it as it was. */
function AddressField({ address, blank, onGo, onCancel, onLeave }: { address: string; blank: boolean; onGo(text: string): void; onCancel(): void; onLeave(): void }) {
  const [text, setText] = useState(address)
  const input = useRef<HTMLInputElement>(null)
  // Opened by a click on the address, it's to type in; opened with a blank page, as any field on open (not under a finger).
  useEffect(() => {
    if (blank && !autoFocusOnOpen()) return
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

/** How long a load goes unshown: one done sooner shows nothing, so it doesn't flash. */
export const SHOW_AFTER = 100
/** How long a load done shows full before it goes: its line filling, then fading (styles.css). */
export const FINISH = 500
/** How long a page sent somewhere has to say it's loading before the pane stops saying so for it. */
const STARTING = 3000

/**
 * The load shown, by its count, while `loading` (from SHOW_AFTER in), and for FINISH once it's done; none otherwise.
 * Loading again as one finishes, the next is shown at once.
 */
function useShownLoad(loading: boolean) {
  const [shown, setShown] = useState<number>()
  const count = useRef(0)
  const showing = useRef(shown)
  showing.current = shown
  useEffect(() => {
    if (!loading) {
      if (showing.current === undefined) return
      const timer = setTimeout(() => setShown(undefined), FINISH)
      return () => clearTimeout(timer)
    }
    const load = ++count.current
    if (showing.current !== undefined) return setShown(load)
    const timer = setTimeout(() => setShown(load), SHOW_AFTER)
    return () => clearTimeout(timer)
  }, [loading])
  return shown
}

/**
 * A load as a line along the toolbar's foot, in two parts laid over each other: one easing toward 80% from the load's
 * start (an animation of its own, the compositor's), the other at the page's `progress` as it comes. Done, it fills,
 * and fades. Under reduced motion it neither eases nor fades: a short line, the progress over it in steps.
 */
function LoadBar({ loading, progress }: { loading: boolean; progress: number | undefined }) {
  const now = loading ? progress ?? 0 : 1
  return (
    <div className={`browser-load ${loading ? '' : 'is-done'}`} role="progressbar" aria-label="Loading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(now * 100)}>
      <i className="browser-load__wait" style={{ animationDelay: `-${SHOW_AFTER}ms` }} />
      <i className="browser-load__now" style={{ transform: `scaleX(${now})` }} />
    </div>
  )
}

/** In place of the globe while a page loads: the app's spinner. */
const Spinner = () => <Glyph shape="working" className="browser-spinner" />

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

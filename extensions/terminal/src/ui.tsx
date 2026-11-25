// terminal, UI half: the Terminal pane (from the pane menu, ⌃`, or the agent's pane_open "terminal"), drawn by
// ghostty-web: Ghostty's terminal emulator compiled to WebAssembly, behind xterm.js's API, the same in the desktop app
// and a browser. The shell is the machine's (the daemon half): this attaches to it on the pane's channel, replays what
// it printed, and passes keys and sizes back. Native libghostty on the desktop is a later step (docs/design.md, Next).
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { call, channel as openChannel, defineAction, defineUiExtension, PaneButton, StatusGlyph, useTabNote, useValue, type BridgeChannel, type PaneProps } from '@superego/app/ui'
import type { Pane } from '@superego/protocol'
import { autoFocusOnOpen, TerminalIcon } from '@superego/ui'
import './styles.css'
import { about, Framing, IO, RESIZE, STATUS, TERMINAL, type TerminalStatuses } from './shared.ts'
import { lookOf, sameLook, type Look } from './theme.ts'

const numberOf = (pane: Pane) => Number((pane.params as { n?: unknown } | undefined)?.n) || 1
/** ⌃`, the terminal's own shortcut: the window takes it even from inside a terminal. */
const KEYS = 'ctrl+`'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.pane(TERMINAL, {
      title: (pane) => numberOf(pane) > 1 ? `Terminal ${numberOf(pane)}` : 'Terminal',
      icon: TerminalIcon, component: TerminalPane, menu: true,
    })
    superego.action(defineAction({
      id: 'terminal.open', title: 'Open a terminal', keys: KEYS,
      when: (c) => Boolean(c.selection),
      run: async (_p, c) => { if (c.selection) await c.dispatch('pane.open', { thread: c.selection.thread, kind: TERMINAL }, { machine: c.selection.machine, source: 'terminal' }) },
    }))
    superego.action(defineAction({
      id: 'terminal.new', title: 'New terminal',
      when: (c) => Boolean(c.selection),
      run: async (_p, c) => {
        if (!c.selection) return
        const panes = c.threadOf(c.selection)?.panes ?? []
        const n = Math.max(0, ...panes.filter((p) => p.kind === TERMINAL).map(numberOf)) + 1
        await c.dispatch('pane.open', { thread: c.selection.thread, kind: TERMINAL, ...(n > 1 ? { params: { n } } : {}) }, { machine: c.selection.machine, source: 'terminal' })
      },
    }))
  },
})

/**
 * The look of the terminal in `host`, as the window draws it now: read when it mounts, and again when light or dark
 * flips or the root's style or class changes (the accent, the fonts, the text size, a theme). Never per frame; a read
 * that comes to the same look keeps the one before, so the terminal isn't made again for nothing.
 */
function useLook(host: RefObject<HTMLElement | null>): { look?: Look; problem?: string } {
  const [state, setState] = useState<{ look?: Look; problem?: string }>({})
  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const scheme = matchMedia('(prefers-color-scheme: dark)')
    const read = () => {
      try {
        const look = lookOf(element)
        setState((before) => before.look && sameLook(before.look, look) ? before : { look })
      } catch (error) {
        console.error('Reading the terminal’s look failed:', error)
        setState({ problem: (error as Error).message })
      }
    }
    read()
    scheme.addEventListener('change', read)
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => { scheme.removeEventListener('change', read); observer.disconnect() }
  }, [host])
  return state
}

const mac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
/**
 * Keys the window takes even from inside a terminal: on a Mac, ⌘ anything but copy and paste; elsewhere, ⌃⇧ anything;
 * and everywhere ⌃Tab (the next pane) and ⌃` (this). The rest are the terminal's: ⌃D is the shell's, not a scroll.
 */
function windowTakes(event: KeyboardEvent) {
  if (event.ctrlKey && (event.key === 'Tab' || event.code === 'Backquote')) return true
  if (mac) return event.metaKey && !['KeyC', 'KeyV'].includes(event.code)
  return event.ctrlKey && event.shiftKey && !['KeyC', 'KeyV'].includes(event.code)
}

/** A shell on the thread's machine, in its folder: attached while the pane is shown, running whether or not it is. */
function TerminalPane({ machine, thread, pane }: PaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const { look, problem: lookProblem } = useLook(host)
  const [problem, setProblem] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const connected = machine.state === 'connected'
  const status = (useValue<TerminalStatuses>(machine, STATUS, { scope: thread.id }) ?? {})[pane.id]
  useTabNote(status ? <StatusGlyph status={status} /> : null, status ? JSON.stringify(status) : '')

  useEffect(() => {
    const element = host.current
    if (!element || !connected || !look) return
    setProblem(undefined)
    let disposed = false
    let channel: BridgeChannel | undefined
    const cleanups: (() => void)[] = []
    void (async () => {
      const ghostty = await import('ghostty-web')
      await ghostty.init()
      if (disposed) return
      const term = new ghostty.Terminal({ ...look, cursorBlink: true, scrollback: 10_000 })
      cleanups.push(() => term.dispose())
      term.open(element)
      // Its text, for tests and a look from the devtools: `document.querySelector('.terminal-pane__screen').text()`.
      Object.defineProperty(element, 'text', { configurable: true, value: () => {
        const buffer = term.buffer.active
        return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n').trimEnd()
      } })
      term.attachCustomKeyEventHandler(windowTakes)
      // What the terminal doesn't pass on is its own: kept from the window's shortcuts.
      const own = (event: KeyboardEvent) => { if (!windowTakes(event)) event.stopPropagation() }
      element.addEventListener('keydown', own)
      cleanups.push(() => element.removeEventListener('keydown', own))
      const fit = new ghostty.FitAddon()
      term.loadAddon(fit)
      fit.fit()
      const opened = await openChannel(machine.id, IO, { thread: thread.id, pane: pane.id, cols: term.cols, rows: term.rows })
      if (disposed) { opened.close(); return }
      channel = opened
      // Replayed output may hold a program's questions to the terminal (where's the cursor?): its answers then aren't
      // for anyone, so nothing typed is sent until the replay is written.
      const framing = new Framing()
      let replaying = true
      const encoder = new TextEncoder()
      // Written as it comes: the emulator takes it at once (its callback waits for a frame, and a hidden window or tab
      // draws none, which would hold up the shell).
      // What's replayed is written at the size it was printed at, so a line the shell redrew lands where it did; then
      // the terminal fits its pane again (the shell redraws for that).
      let sized = false
      channel.onData((bytes) => {
        if (disposed) return
        const { replayed, live } = framing.split(bytes)
        if (!sized && framing.size) { sized = true; term.resize(framing.size.cols, framing.size.rows) }
        if (replayed.length) term.write(replayed)
        if (replaying && framing.live) { replaying = false; fit.fit() }
        if (live.length) term.write(live)
      })
      const typed = term.onData((text) => { if (!replaying) channel!.write(encoder.encode(text)) })
      // Sized for the replay isn't the pane's size: only the pane's is the shell's.
      const resized = term.onResize(({ cols, rows }) => { if (!replaying) void call(machine.id, RESIZE, { thread: thread.id, pane: pane.id, cols, rows }).catch(() => {}) })
      cleanups.push(() => { typed.dispose(); resized.dispose() })
      fit.observeResize()
      cleanups.push(() => fit.dispose())
      channel.onClose((reason) => { if (!disposed) setProblem(reason ?? 'The terminal closed.') })
      // The pane took the focus before the terminal was there: it's the terminal's now (as a field's on open: not
      // under a finger, where the keyboard would come up; a tap on the terminal brings it).
      if (autoFocusOnOpen() && element.closest('[data-column]')?.contains(document.activeElement)) term.focus()
    })().catch((error: Error) => { if (!disposed) setProblem(error.message) })
    return () => {
      disposed = true
      channel?.close()
      for (const cleanup of cleanups.reverse()) cleanup()
      element.replaceChildren()
    }
  }, [machine.id, connected, thread.id, pane.id, look, attempt])

  return (
    <div className="terminal-pane">
      {/* Focusable before the terminal is in it: the pane's focus (going to it, or back to a thread with it focused) lands
          here, and the terminal takes it from here once it's there. */}
      <div ref={host} className="terminal-pane__screen" data-focus tabIndex={-1} />
      {lookProblem && <div className="terminal-pane__problem"><span>{lookProblem}</span></div>}
      {problem && connected && (
        <div className="terminal-pane__problem">
          <span>{problem}</span>
          <PaneButton onClick={() => setAttempt((n) => n + 1)}>Reconnect</PaneButton>
        </div>
      )}
    </div>
  )
}

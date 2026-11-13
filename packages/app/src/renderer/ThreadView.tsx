import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react'
import type { ConversationView, EntryRecord, InboxState, LiveState } from '@earendil-works/pi-durable'
import type { Attachment, ThreadInfo } from '@superego/protocol'
import { ArchiveIcon, ArrowCounterClockwiseIcon, BroomIcon, ArrowDownIcon, ArrowElbowDownRightIcon, ArrowElbowRightIcon, ArrowRightIcon, ArrowUpIcon, Button, CaretRightIcon, ChatCircleIcon, ChatsCircleIcon, CheckIcon, FileIcon, FilePlusIcon, FileTextIcon, type Icon as PhosphorIcon, IconButton, Menu, MinusIcon, PauseIcon, PaperclipIcon, PencilSimpleIcon, SparkleIcon, ColumnsIcon, PlusIcon, StatusGlyph, statusLabel, StopIcon, TerminalIcon, TextArea, WrenchIcon, XIcon } from '@superego/ui'
import type { MachineEntry } from '../shared.ts'
import { call, machine as client, useThreadView } from './client.ts'
import { completionsIn, divideWork, entryView, fileKind, folderKind, paneMenu, sentWithIn, Slot, shownPanes, toolView, unfoldedTool, urlKind, useRegistry, type ToolCallProps, type WorkBlock as Block, type WorkPart, type WorkStatus } from './extension.tsx'
import { useShell } from './state.tsx'
import { useShortcut } from './keys.ts'
import { ctrlDigit } from './shortcuts.ts'
import { Images, imagesIn, Markdown, OpenFile, OpenUrl, Scroll, ThreadMachine } from './Markdown.tsx'
import { ThreadRef } from './thread-ref.tsx'
import { useLocalState } from './local-state.ts'
import { readAttachment, splitMessage } from './attachments.ts'
import { askFor, complete, completing, menuFor, readSent, type Completion, type Offered, type SentBlock } from './composer.ts'
import { useProfileUi } from './profile-ui.ts'
import { ThreadPanes } from './panes.tsx'
import { startRename, stopRename, useRenaming } from './rename.ts'

type Message = { role: string; content: string | Block[]; toolCallId?: string; isError?: boolean; details?: unknown }

/** The thread a transcript belongs to, for extension renderers. */
const Here = createContext<{ machine: MachineEntry; thread: ThreadInfo }>(undefined as never)

/**
 * Something above the composer that wants what is typed: an answer to a question, say. The newest claim wins. `keyDown`
 * sees the composer's keys first (with what's typed) and returns true for those it took: picking an option, say.
 */
export type ComposerClaim = { placeholder: string; submit(text: string): Promise<unknown>; keyDown?(event: KeyboardEvent, text: string): boolean }
const ClaimContext = createContext<(claim: ComposerClaim) => () => void>(() => () => {})

/** While mounted (and given a claim), the composer's text goes to `claim.submit` instead of the thread. */
export function useComposerClaim(claim: ComposerClaim | undefined) {
  const register = useContext(ClaimContext)
  const latest = useRef(claim)
  latest.current = claim
  useEffect(() => {
    if (!claim) return
    return register({
      get placeholder() { return latest.current?.placeholder ?? '' },
      submit: (text) => latest.current!.submit(text),
      keyDown: (event, text) => latest.current?.keyDown?.(event, text) ?? false,
    })
  }, [Boolean(claim), register])
}

/** The composer, to what's above it (`composer.above`): what's typed, and ways to put words in it. */
export type Composer = {
  text: string
  /** Replace what's typed with `text`, ready to send or change. */
  fill(text: string): void
  /**
   * Offer `messages` in the empty composer: ←/→ pick one (shown as the placeholder), ⏎ sends it, ⇥ puts it in the box
   * to change. ⌃1–⌃9 send the first nine, from the prompt or anywhere else in the thread's view. Undefined (or none)
   * offers nothing.
   */
  suggest(messages: string[] | undefined): void
  /** Which offered message is picked, while the composer offers them. */
  picked: number | undefined
}
const ComposerContext = createContext<Composer>({ text: '', fill() {}, suggest() {}, picked: undefined })

/** The composer of the thread this is drawn above. */
export const useComposer = () => useContext(ComposerContext)

const blocks = (message: Message | undefined): Block[] =>
  !message ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
const textOf = (message: Message | undefined) => blocks(message).map((b) => b.text ?? '').join('')

/** A thread: its transcript and composer, and the panes open beside it. */
export function ThreadView({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  // The thread's profile may bring UI of its own (header, aside, composer, tool renderers, panes).
  useProfileUi(machine.id, thread)
  return <ThreadPanes machine={machine} thread={thread} main={<ThreadBody machine={machine} thread={thread} />} />
}

/**
 * Where you are, in the window's title bar: the thread's session (and machine, where it isn't this one), then its status
 * and title, with a button to rename it (or the name being edited), and the key that goes anywhere else.
 */
export function ThreadTitle({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const editing = useRenaming() === `${machine.id}/${thread.id}`
  const dispatch = useRegistry().router.dispatch
  const goKeys = useShortcut('app.navigator')
  const navigate = () => void dispatch('app.navigator', {}, { source: 'titlebar' }).catch((error) => console.error(error))
  return (
    <span className="titlebar__crumb">
      <span className="titlebar__seg titlebar__session" title={`${thread.session?.name ?? folderName(thread.cwd)}\n${thread.cwd}`}>
        {machine.id !== 'local' && <>{machine.label}<span className="titlebar__dot">·</span></>}
        {thread.session?.name ?? folderName(thread.cwd)}
      </span>
      <span className="titlebar__sep" aria-hidden>›</span>
      <span className="titlebar__seg titlebar__title">
        <StatusGlyph status={thread.status} />
        {editing ? <TitleField machine={machine} thread={thread} /> : (
          <>
            <span className="thread__title" title={thread.title} onDoubleClick={() => startRename(machine.id, thread.id)}>{thread.title.replace(/\.$/, '')}</span>
            <IconButton label="Rename" className="titlebar__rename" onClick={() => startRename(machine.id, thread.id)}>
              <PencilSimpleIcon size={13} aria-hidden />
            </IconButton>
          </>
        )}
      </span>
      {thread.archived && <span className="titlebar__archived">Archived</span>}
      {goKeys && !editing && (
        <button type="button" className="titlebar__go" title="Go to a session, thread or pane" onClick={navigate}>{goKeys}</button>
      )}
    </span>
  )
}

/** The title, editable: ⏎ (or leaving it) renames the thread, esc leaves it as it was. */
function TitleField({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const dispatch = useRegistry().router.dispatch
  const done = useRef(false)
  const finish = (title: string | undefined) => {
    if (done.current) return
    done.current = true
    stopRename()
    const next = title?.trim()
    if (next && next !== thread.title) void dispatch('thread.rename', { id: thread.id, title: next }, { machine: machine.id, source: 'titlebar' }).catch((error) => console.error(error))
  }
  return (
    <input className="titlebar__field" aria-label="Thread title" defaultValue={thread.title} autoFocus spellCheck={false}
      onFocus={(e) => e.currentTarget.select()} onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(e.currentTarget.value) }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(undefined) }
      }} />
  )
}

/**
 * What the title bar says about the thread, at its right: where it runs (the machine when it isn't this one, the
 * project, its worktree's branch, its profile), its profile's own header, panes to open, and archiving it.
 */
export function ThreadTools({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  return (
    <span className="thread__tools">
      <span className="thread__crumb">
        {thread.parent && <span className="titlebar__chip thread__parent">from <ThreadRef machine={machine.id} id={thread.parent} /></span>}
        {thread.worktree && <span className="titlebar__chip thread__branch" title={`${thread.worktree.branch}\n${thread.worktree.path}`}>{thread.worktree.branch}</span>}
        {thread.profile && <span className="titlebar__chip thread__profile" title={thread.profile.scope === 'project' ? "This project's profile" : 'Your profile'}>{thread.profile.name}</span>}
      </span>
      <Slot name="thread.header" props={{ machine, thread }} />
      {thread.cost !== undefined && thread.cost > 0 && <span className="thread__cost" title="Spent on this thread">${thread.cost.toFixed(2)}</span>}
      {/* Without a pane shown, there's no strip to open one from: here instead. */}
      {!shownPanes(registry, { machine: machine.id, thread }).length && <PaneMenu machine={machine} thread={thread} />}
      {thread.meta
        ? (
          // Ego is kept, not archived: cleared, it starts empty again.
          <IconButton label="Clear" className="thread__clear" onClick={() => void dispatch('thread.meta.clear', {}, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))}>
            <BroomIcon size={15} aria-hidden />
          </IconButton>
        )
        : thread.archived
        ? <UnarchiveButton machine={machine} thread={thread} />
        : (
          <IconButton label="Archive (⌘⇧E)" className="thread__archive" onClick={() => void dispatch('thread.archive', { id: thread.id }, { machine: machine.id, source: 'header' })}>
            <ArchiveIcon size={15} aria-hidden />
          </IconButton>
        )}
    </span>
  )
}

/** Brings an archived thread back: into its session, with its worktree, taking messages again. */
function UnarchiveButton({ machine, thread, className = '' }: { machine: MachineEntry; thread: ThreadInfo; className?: string }) {
  const dispatch = useRegistry().router.dispatch
  return (
    <Button className={`thread__unarchive ${className}`} onClick={() => void dispatch('thread.unarchive', { id: thread.id }, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))}>
      <ArrowCounterClockwiseIcon size={14} aria-hidden /> Unarchive
    </Button>
  )
}

/** A prompt's transcript: the thread it's under. */
const transcriptOf = (prompt: Element) => prompt.closest('.dock')?.parentElement?.querySelector<HTMLElement>(':scope > .thread__scroll')

/** How far from its end a transcript still counts as at its end, and follows what comes in. */
const PINNED = 80

/** A thread's transcript and composer. Also what a "thread" pane draws. */
export function ThreadBody({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  // A file the thread names, opened beside it: in the pane kind that takes it (a profile's, else the editor), at the
  // line it names; a folder in the kind that shows folders. Else why not, for the link to say.
  const threadRef = useRef(thread)
  threadRef.current = thread
  const openFile = useCallback(async (name: string): Promise<string | undefined> => {
    try {
      const found = await client(machine.id).call('file.find', { id: thread.id, name })
      const folder = shortPath(threadRef.current.cwd)
      if (found.outside) return `outside ${folder}, where this thread works`
      if (found.path === null) return `not in ${folder}`
      const where = { machine: machine.id, thread: threadRef.current }
      const kind = found.folder ? folderKind(registry, where) : fileKind(registry, where, found.path)
      if (!kind) return found.folder ? 'a folder, and nothing here shows folders' : 'a file, and nothing here shows files'
      await dispatch('pane.open', { id: thread.id, kind, params: { path: found.path, ...(found.line ? { line: found.line } : {}) } }, { machine: machine.id, source: 'thread' })
      return undefined
    } catch (error) { return (error as Error).message }
  }, [machine.id, thread.id, registry])
  // A web page the thread links to, opened beside it in the pane kind that shows web pages; with none here, links open in
  // the browser only.
  const webKind = urlKind(registry, { machine: machine.id, thread })
  const openUrl = useCallback((url: string) => {
    if (!webKind) return
    const host = URL.parse(url)?.host
    void dispatch('pane.open', { id: thread.id, kind: webKind, ...(host ? { title: host } : {}), params: { url } }, { machine: machine.id, source: 'thread' })
      .catch((error) => console.error(error))
  }, [machine.id, thread.id, webKind])
  const watched = useThreadView(machine.id, machine.state === 'connected', thread.id)
  const live = watched?.docs['pi.live'] as LiveState | undefined
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  // Scrolled up from the end: the composer offers a way back down.
  const [away, setAway] = useState(false)
  const jumpToEnd = useCallback(() => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // Scrolling back: the watch holds the newest entries; older ones come a page at a time as the top comes near. Every
  // entry seen is kept (the watch's window slides on as the thread grows), so the transcript only ever grows backwards.
  const seen = useRef(new Map<number, EntryRecord>())
  const [older, setOlder] = useState<{ more: boolean; loading: boolean }>({ more: true, loading: false })
  for (const entry of watched?.entries ?? []) seen.current.set(entry.id as number, entry)
  // A window that starts the transcript has nothing before it: entries seen earlier went with a clear.
  if (watched && watched.before === undefined) {
    const first = (watched.entries[0]?.id as number | undefined) ?? Infinity
    for (const id of seen.current.keys()) if (id < first) seen.current.delete(id)
  }
  const entries = useMemo(() => [...seen.current.values()].sort((a, b) => (a.id as number) - (b.id as number)), [watched, older])
  const atStart = watched !== undefined && (watched.before === undefined || (entries[0] !== undefined && !older.more && !older.loading))
  const view = useMemo(() => watched && { ...watched, entries, before: atStart ? undefined : entries[0]?.id }, [watched, entries, atStart])
  const keep = useRef<{ height: number; top: number }>(undefined)
  const loadOlder = useCallback(() => {
    const el = scroller.current
    const first = entries[0]
    if (!el || !first || atStart || older.loading) return
    setOlder((o) => ({ ...o, loading: true }))
    void client(machine.id).call('thread.history', { id: thread.id, before: first.id as number, limit: 50 }).then(({ entries: page, more }) => {
      keep.current = { height: el.scrollHeight, top: el.scrollTop }
      for (const entry of page as EntryRecord[]) seen.current.set(entry.id as number, entry)
      setOlder({ more: more && page.length > 0, loading: false })
    }, () => setOlder((o) => ({ ...o, loading: false })))
  }, [machine.id, thread.id, entries, atStart, older.loading])
  // A page arrived above: what was in view stays where it was.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !keep.current) return
    el.scrollTop = keep.current.top + (el.scrollHeight - keep.current.height)
    keep.current = undefined
  }, [older])
  // Too short to scroll yet, with more before it: keep fetching until it fills the view or starts.
  useEffect(() => {
    const el = scroller.current
    if (el && view && !atStart && !older.loading && el.scrollHeight <= el.clientHeight + 200) loadOlder()
  }, [view, atStart, older.loading])

  // Its images, in messages: files of its folder on its machine.
  const images = useMemo(() => imagesIn(machine, thread.id, thread.cwd), [machine, thread.id, thread.cwd])

  // At the end, the transcript stays at its end as anything changes size: a reply streaming in, a step opening, code
  // laid out, the composer floating over the end growing (suggestions, a question, files; the transcript keeps room for
  // it below its end, --dock). Scrolled up past the dead zone (PINNED), it stays where it was put.
  useLayoutEffect(() => {
    const el = scroller.current
    const column = el?.querySelector<HTMLElement>('.thread__column')
    const dock = el?.parentElement?.querySelector<HTMLElement>(':scope > .dock')
    if (!el || !column || !dock) return
    const observer = new ResizeObserver(() => {
      el.parentElement!.style.setProperty('--dock', `${dock.offsetHeight}px`)
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(column)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [])

  return (
    <OpenFile.Provider value={openFile}>
    <OpenUrl.Provider value={webKind ? openUrl : undefined}>
    <ThreadMachine.Provider value={machine.id}>
    <Here.Provider value={{ machine, thread }}>
    <Images.Provider value={images}>
    <div className="thread">
      {/* The thread itself can hold the focus, to read and scroll from the keyboard; typing there goes on to the prompt (space pages down). */}
      <div className="thread__scroll" ref={scroller} tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key.length !== 1 || e.key === ' ' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.target !== e.currentTarget) return
          e.currentTarget.parentElement?.querySelector<HTMLTextAreaElement>(':scope > .dock .composer textarea:not(:disabled)')?.focus()
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED
          setAway(el.scrollHeight - el.scrollTop - el.clientHeight > 200)
          el.parentElement?.classList.toggle('is-scrolled', el.scrollTop > 8)
          if (el.scrollTop < el.clientHeight) loadOlder()
        }}>
        <div className="thread__column">
          {view ? <Transcript view={view} live={live} /> : <div className="transcript__more">Loading…</div>}
          {view && <Queued inbox={watched?.docs['pi.inbox'] as InboxState | undefined} />}
        </div>
      </div>
      <Composer machine={machine} thread={thread} busy={Boolean(live?.run)} onJump={away ? jumpToEnd : undefined} />
    </div>
    </Images.Provider>
    </Here.Provider>
    </ThreadMachine.Provider>
    </OpenUrl.Provider>
    </OpenFile.Provider>
  )
}

/** The project folder's own name; home reads as `~`. */
const folderName = (path: string) => { const short = shortPath(path); return short === '~' ? short : short.split('/').filter(Boolean).at(-1) ?? short }

/** A home-relative path: `/Users/me/dev/x` reads as `~/dev/x`. */
export const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

function Transcript({ view, live }: { view: ConversationView; live: LiveState | undefined }) {
  const here = useContext(Here)
  const registry = useRegistry()
  // Tool results render inside the call that asked for them.
  const results = useMemo(() => {
    const map = new Map<string, Message>()
    for (const entry of view.entries) {
      const message = entry.model?.[0] as Message | undefined
      if (message?.role === 'toolResult' && message.toolCallId) map.set(message.toolCallId, message)
    }
    return map
  }, [view.entries])
  const running = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]))
  const partial = live?.generation?.message as Message | undefined
  const items = useMemo(() => flatten(view.entries, partial), [view.entries, partial])
  const result = (id: string) => { const message = results.get(id); return message && { text: textOf(message), isError: Boolean(message.isError) } }

  return (
    <div className="transcript">
      {view.before !== undefined && <div className="transcript__more">Loading earlier messages…</div>}
      {items.map((item, index) => {
        const last = index === items.length - 1
        switch (item.type) {
          case 'entry': return <Entry key={item.key} entry={item.entry} />
          case 'text': return (
            <div key={item.key} className={`msg msg__text ${item.narration ? 'msg__text--narration' : ''} ${item.streaming ? 'is-streaming' : ''}`}><Markdown text={item.text} /></div>
          )
          case 'work': {
            // Extensions may divide a run into parts (an agent's reported tasks); the last part is the one going on, and a
            // task still running is only ever that one (one left open when its run ends is interrupted).
            const active = last && Boolean(live?.run)
            const parts = divideWork(registry, { machine: here.machine.id, thread: here.thread }, { blocks: item.blocks, active, result })
            return parts.map((part, i) => part.title !== undefined
              ? <Task key={`${item.key}:${i}`} part={part} results={results} running={running} />
              : part.blocks.length ? <Work key={`${item.key}:${i}`} blocks={part.blocks} results={results} running={running} active={active && i === parts.length - 1} /> : null)
          }
          case 'end': return <TurnEnd key={item.key} blocks={divideWork(registry, { machine: here.machine.id, thread: here.thread }, { blocks: item.blocks, active: false, result }).flatMap((part) => part.blocks)} results={results} />
        }
      })}
      {live?.run && !partial && here.thread.status.state === 'working' && <div className="transcript__thinking">working…</div>}
      {live?.runFailure && !live.run && live.runFailure.reason !== 'aborted' && (
        <div className="transcript__error">Run failed: {live.runFailure.reason}{live.runFailure.detail ? ` — ${live.runFailure.detail}` : ''}</div>
      )}
    </div>
  )
}

/**
 * What you sent while the agent was busy, waiting its turn: shown as soon as it's sent, faint, and saying when it goes
 * in (a steer after the current step, a follow-up when the agent is done). Placed, it becomes an entry like any other.
 */
function Queued({ inbox }: { inbox: InboxState | undefined }) {
  const items = (inbox?.items ?? []).filter((item) => item.mode !== 'write')
  if (!items.length) return null
  return (
    <div className="queued">
      {items.map((item) => {
        const content = item.content as Message['content']
        return (
          <Sent key={String(item.id)} className="msg msg--user msg--queued" blocks={typeof content === 'string' ? [{ type: 'text', text: content }] : content}>
            <span className="msg__queued">{item.mode === 'steer' ? 'Waiting · steers after this step' : 'Queued · sent when the agent is done'}</span>
          </Sent>
        )
      })}
    </div>
  )
}

/**
 * A message you sent: your words, whole, and what went with them below: what extensions put in it (a skill it named,
 * drawn by the extension that sent it along), then its files.
 */
function Sent({ blocks, className, children }: { blocks: SentBlock[]; className: string; children?: ReactNode }) {
  const here = useContext(Here)
  const registry = useRegistry()
  const { found, rest } = readSent(sentWithIn(registry, { machine: here.machine.id, thread: here.thread }), blocks)
  const { text, files } = splitMessage(rest)
  if (!text && !found.length && !files.length && !children) return null
  return (
    <div className={className}>
      {text && <Markdown text={text} breaks />}
      {(found.length > 0 || files.length > 0) && (
        <div className="msg__files">
          {found.map(({ reader: { component: Component, owner }, items }) => <Component key={`${owner.profile ?? ''}/${owner.extension}`} {...here} items={items} />)}
          <Files files={files} />
        </div>
      )}
      {children}
    </div>
  )
}

/** The files that went with a message. */
function Files({ files }: { files: ReturnType<typeof splitMessage>['files'] }) {
  return (
    <>
      {/* An image shows as itself, its name on hover; other files as a chip with their name. */}
      {files.map((file, index) => file.image
        ? <span key={`${file.path}-${index}`} className="attachment attachment--image" title={file.name}><img src={file.image} alt={file.name} /></span>
        : (
          <span key={`${file.path}-${index}`} className="attachment" title={file.path}>
            <span className="attachment__icon"><FileIcon size={14} aria-hidden /></span>
            <span className="attachment__name">{file.name}</span>
          </span>
        ))}
    </>
  )
}

type Slots = Map<string, NonNullable<LiveState['tools']>[number]>

/**
 * What a transcript shows, in order: your messages (and extensions' entries), the agent's text, and runs of work
 * (thinking and tool calls back to back, even across the agent's turns). Text in a turn that goes on to call tools is
 * narration; the text that ends a turn is the answer.
 */
type Item =
  | { type: 'entry'; key: string; entry: EntryRecord }
  | { type: 'text'; key: string; text: string; narration: boolean; streaming?: boolean }
  | { type: 'work'; key: string; blocks: Block[] }
  | { type: 'end'; key: string; blocks: Block[] }

function flatten(entries: readonly EntryRecord[], partial: Message | undefined): Item[] {
  const items: Item[] = []
  const add = (message: Message, key: string, streaming = false) => {
    const list = blocks(message)
    const narration = list.some((b) => b.type === 'toolCall')
    list.forEach((block, index) => {
      const last = items.at(-1)
      if (block.type === 'text' && !narration) {
        // An answer: what the agent says, outside the work.
        if (block.text?.trim()) items.push({ type: 'text', key: `${key}:${index}`, text: block.text, narration, streaming })
      } else if (block.type === 'toolCall' || (block.type === 'thinking' && block.thinking) || (block.type === 'text' && block.text?.trim())) {
        // Work, and what the agent says along the way (text beside tool calls): one fold from a message to the answer.
        if (last?.type === 'work') last.blocks.push(block)
        else items.push({ type: 'work', key: `${key}:${index}`, blocks: [block] })
      }
    })
  }
  // A turn that did work ends with a line saying what it did: the anchor between one turn and the next.
  let turn: Block[] = []
  const end = (key: string) => {
    if (turn.some((b) => b.type === 'toolCall')) items.push({ type: 'end', key: `end:${key}`, blocks: turn })
    turn = []
  }
  for (const entry of entries) {
    const message = entry.model?.[0] as Message | undefined
    if (message?.role === 'assistant') { add(message, String(entry.id)); turn.push(...blocks(message)) }
    else if (message?.role === 'toolResult' || entry.kind === 'pi.system') continue
    else { if (message?.role === 'user') end(String(entry.id)); items.push({ type: 'entry', key: String(entry.id), entry }) }
  }
  if (partial) add(partial, 'live', true)
  else end('last')
  return items
}

/** "6 steps · +11 −2 · 1 failed" under a finished turn. */
function TurnEnd({ blocks, results }: { blocks: Block[]; results: Map<string, Message> }) {
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const failed = calls.filter((b) => results.get(b.id!)?.isError).length
  const stats = sumStats(calls, results)
  return (
    <div className="turn-end">
      <span>{calls.length === 1 ? '1 step' : `${calls.length} steps`}</span>
      {(stats.added > 0 || stats.removed > 0) && <span><Stat {...stats} /></span>}
      {failed > 0 && <span>{failed} retried</span>}
    </div>
  )
}

function sumStats(calls: Block[], results: Map<string, Message>) {
  return calls.reduce((sum, b) => {
    const diff = diffOf(results.get(b.id!)?.details)
    if (!diff) return sum
    const stat = diffStat(diff)
    return { added: sum.added + stat.added, removed: sum.removed + stat.removed }
  }, { added: 0, removed: 0 })
}

function Entry({ entry }: { entry: EntryRecord }) {
  const here = useContext(Here)
  const custom = entryView(useRegistry(), entry.kind, { machine: here.machine.id, thread: here.thread })
  if (custom) { const Custom = custom; return <Custom {...here} entry={{ id: entry.id, kind: entry.kind, data: entry.data }} /> }
  const message = entry.model?.[0] as Message | undefined
  if (message?.role === 'user') {
    return <Sent className="msg msg--user" blocks={blocks(message)} />
  }
  return <div className="msg msg--note">{entry.kind}</div>
}

/** A run's blocks as rows: thinking, what the agent said along the way, tool calls. */
const steps = (blocks: Block[], results: Map<string, Message>, running: Slots) => blocks.map((block, index) => block.type === 'thinking'
  ? <Thinking key={index} text={block.thinking ?? ''} />
  : block.type === 'text'
    ? <div key={index} className="step__note"><Markdown text={block.text ?? ''} /></div>
    : <ToolCall key={block.id ?? index} block={block} result={results.get(block.id!)} slot={running.get(block.id!)} />)

/**
 * A run of work. One step shows as itself; more fold into one line saying what was done ("Read 2 files and ran a
 * command"), open while the run is going and closed once the agent has moved on.
 *
 * Rows share one anatomy: a chevron hung in the gutter, then an icon at the text's edge, then the label. What a row
 * opens to sits under its icon; inside a run, rows sit under the run's label.
 */
function Work({ blocks: all, results, running, active }: { blocks: Block[]; results: Map<string, Message>; running: Slots; active: boolean }) {
  const [open, setOpen] = useState<boolean>()
  const { blocks, shown } = useUnfolded(all, results, running)
  if (!blocks.length) return shown
  const rows = steps(blocks, results, running)
  // One step, or only what the agent said beside what it shows: as itself.
  if ((blocks.length === 1 && blocks[0]!.type !== 'text') || (shown && blocks.every((b) => b.type === 'text'))) return <><div className="steps">{rows}</div>{shown}</>
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const failed = calls.filter((b) => results.get(b.id!)?.isError).length
  const stats = sumStats(calls, results)
  // Folded, while it works too; opened only by hand.
  const folded = open ?? false
  return (
    <>
      <details className="steps steps--run" open={folded} onToggle={(e) => { const next = e.currentTarget.open; if (next !== folded) setOpen(next) }}>
        <summary className="row">
          <Chevron />
          {active ? <StatusGlyph status={{ state: 'working' }} /> : <Icon name={mainKind(blocks)} />}
          <span className="row__label row__summary" title={describe(blocks).join('')}>{describe(blocks).map((part, i) => i % 2 ? <code key={i} className="row__path">{part}</code> : part)}</span>
          {(stats.added > 0 || stats.removed > 0) && <span className="row__meta"><Stat {...stats} /></span>}
          {failed > 0 && <span className="row__failed">{failed} failed</span>}
        </summary>
        <div className="run__steps">{rows}</div>
      </details>
      {shown}
    </>
  )
}

/**
 * A run's blocks without the calls an extension shows unfolded (`tool(name, component, { fold: false })`: images the
 * agent showed, say), and those calls drawn on their own, to go under the fold.
 */
function useUnfolded(all: Block[], results: Map<string, Message>, running: Slots) {
  const registry = useRegistry()
  const here = useContext(Here)
  const where = { machine: here.machine.id, thread: here.thread }
  const out = all.filter((b) => b.type === 'toolCall' && unfoldedTool(registry, b.name ?? '', where))
  if (!out.length) return { blocks: all, shown: null }
  return { blocks: all.filter((b) => !out.includes(b)), shown: <div className="steps steps--unfolded">{steps(out, results, running)}</div> }
}

/**
 * A titled part of a run (a task the agent reported): how it went, its title, and its outcome under it, all shown
 * folded; its steps under that, opened by hand.
 */
function Task({ part, results, running }: { part: WorkPart; results: Map<string, Message>; running: Slots }) {
  const [open, setOpen] = useState(false)
  const status = part.status ?? 'success'
  const { blocks, shown } = useUnfolded(part.blocks, results, running)
  const calls = blocks.filter((b) => b.type === 'toolCall')
  const stats = sumStats(calls, results)
  const rows = steps(blocks, results, running)
  const summary = (
    <>
      {status === 'running' ? <StatusGlyph status={{ state: 'working' }} /> : <TaskIcon status={status} />}
      <span className="task__body">
        <span className="task__head">
          <span className="row__label row__summary task__title" title={part.title}>{part.title}</span>
          {(stats.added > 0 || stats.removed > 0) && <span className="row__meta"><Stat {...stats} /></span>}
        </span>
        {part.outcome && <span className="task__outcome">{part.outcome}</span>}
      </span>
    </>
  )
  if (!rows.length) return <><div className={`steps task task--${status}`}><div className="row task__row">{summary}</div></div>{shown}</>
  return (
    <>
      <details className={`steps steps--run task task--${status}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="row task__row" aria-label={`${part.title} — ${TASK_LABELS[status]}`}><Chevron />{summary}</summary>
        <div className="run__steps">{rows}</div>
      </details>
      {shown}
    </>
  )
}

const TASK_LABELS: Record<WorkStatus, string> = { running: 'Running', success: 'Done', failure: 'Failed', inconclusive: 'Inconclusive', interrupted: 'Interrupted' }
const TASK_ICONS: Record<Exclude<WorkStatus, 'running'>, PhosphorIcon> = { success: CheckIcon, failure: XIcon, inconclusive: MinusIcon, interrupted: PauseIcon }
function TaskIcon({ status }: { status: Exclude<WorkStatus, 'running'> }) {
  const Glyph = TASK_ICONS[status]
  return <Glyph className="row__icon task__icon" size={14} weight="bold" aria-label={TASK_LABELS[status]} />
}

/** What a run mostly did, by weight: an edit matters more than a command, a command more than a read. */
const WEIGHT = ['edit', 'write', 'bash', 'read']
function mainKind(blocks: Block[]): string {
  const names = blocks.filter((b) => b.type === 'toolCall').map((b) => b.name ?? '')
  return WEIGHT.find((kind) => names.includes(kind)) ?? names[0] ?? 'thinking'
}

/** "Read 2 files, ran 3 commands and edited a file", as text and paths in turn: ['Edited ', 'src/a.ts', ' and ran a command']. */
function describe(blocks: Block[]): string[] {
  const count = new Map<string, number>()
  // Thinking between steps is part of the work; it's named only when that's all there is.
  const tools = blocks.filter((b) => b.type === 'toolCall')
  for (const b of tools.length ? tools : blocks.filter((b) => b.type === 'thinking')) { const kind = b.type === 'thinking' ? 'thinking' : b.name ?? 'tool'; count.set(kind, (count.get(kind) ?? 0) + 1) }
  const n = (k: number, one: string, many: string) => k === 1 ? one : `${k} ${many}`
  // The weightiest kind leads, naming its file when there's one.
  const main = mainKind(blocks)
  const paths = tools.filter((b) => b.name === main).map((b) => (b.arguments as { path?: unknown } | undefined)?.path)
  const only = paths.length === 1 && typeof paths[0] === 'string' ? paths[0] : undefined
  const ordered = [...count].sort((a, b) => (a[0] === main ? -1 : b[0] === main ? 1 : 0))
  const phrases = ordered.map(([kind, k]) => {
    if (kind === main && only) return `${{ read: 'read', edit: 'edited', write: 'wrote' }[kind] ?? kind} \u0000${only}\u0000`
    switch (kind) {
      case 'thinking': return 'thought'
      case 'read': return `read ${n(k, 'a file', 'files')}`
      case 'bash': return `ran ${n(k, 'a command', 'commands')}`
      case 'edit': return `edited ${n(k, 'a file', 'files')}`
      case 'write': return `wrote ${n(k, 'a file', 'files')}`
      case 'thread_start': return `started ${n(k, 'a thread', 'threads')}`
      case 'thread_read': return `read ${n(k, 'a thread', 'threads')}`
      case 'thread_send': return `messaged ${n(k, 'a thread', 'threads')}`
      case 'thread_list': return 'listed threads'
      case 'thread_archive': return `archived ${n(k, 'a thread', 'threads')}`
      default: return `used ${kind}${k > 1 ? ` ${k}×` : ''}`
    }
  })
  const text = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : phrases[0] ?? ''
  return (text.charAt(0).toUpperCase() + text.slice(1)).split('\u0000')
}

const Chevron = () => <CaretRightIcon className="row__chevron" size={12} aria-hidden />

function Thinking({ text }: { text: string }) {
  return (
    <details className="step step--thinking">
      <summary className="row"><Chevron /><Icon name="thinking" /><span className="row__label">Thinking</span></summary>
      <div className="step__thinking">{text}</div>
    </details>
  )
}

/** Tool output, up to a dozen whole lines; the rest behind "Show all". */
function Output({ text, className = '' }: { text: string; className?: string }) {
  const [all, setAll] = useState(false)
  const lines = text.replace(/\n+$/, '').split('\n')
  const long = lines.length > CAP + 3
  return (
    <div className={`step__output ${long && !all ? 'is-cut' : ''} ${className}`}>
      <Scroll>{long && !all ? lines.slice(0, CAP).join('\n') : lines.join('\n')}</Scroll>
      {long && <button type="button" className="step__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  )
}
const CAP = 12

const Stat = ({ added, removed }: { added: number; removed: number }) => (
  <>{added > 0 && <span className="stat--add">+{added}</span>}{added > 0 && removed > 0 && ' '}{removed > 0 && <span className="stat--del">−{removed}</span>}</>
)

/** What a step did, as a verb: "Read", "Ran", "Edited"; "Running" while it runs, "Edit failed" when it failed. */
function verbOf(name: string, state: string): string {
  const verbs: Record<string, [string, string, string]> = {
    read: ['Read', 'Reading', 'Read failed'], bash: ['Ran', 'Running', 'Command failed'],
    edit: ['Edited', 'Editing', 'Edit failed'], write: ['Wrote', 'Writing', 'Write failed'],
    thread_start: ['Started', 'Starting', 'Couldn’t start a thread'], thread_read: ['Read', 'Waiting on', 'Couldn’t read'],
    thread_send: ['Messaged', 'Messaging', 'Couldn’t message'], thread_list: ['Listed threads', 'Listing threads', 'Couldn’t list threads'],
    thread_archive: ['Archived', 'Archiving', 'Couldn’t archive'],
  }
  const verb = verbs[name]
  if (!verb) return state === 'error' ? `${name} failed` : name
  return state === 'error' ? verb[2] : state === 'working' ? verb[1] : verb[0]
}

function ToolCall({ block, result, slot }: { block: Block; result: Message | undefined; slot: ReturnType<Slots['get']> }) {
  const here = useContext(Here)
  const custom = toolView(useRegistry(), block.name ?? '', { machine: here.machine.id, thread: here.thread })
  if (custom) {
    const Custom = custom
    const props: ToolCallProps = {
      ...here,
      call: { id: block.id ?? '', name: block.name ?? '', arguments: (block.arguments ?? {}) as Record<string, unknown> },
      ...(result ? { result: { text: textOf(result), isError: Boolean(result.isError), details: result.details } } : {}),
      ...(slot ? { live: { status: slot.status, ...(slot.output !== undefined ? { output: slot.output } : {}), details: slot.details } } : {}),
    }
    return <Custom {...props} />
  }
  const args = (block.arguments ?? {}) as Record<string, unknown>
  const output = result ? unwrap(textOf(result)) : slot?.output
  const state = result ? (result.isError ? 'error' : 'done') : slot?.status === 'running' ? 'working' : 'idle'
  const diff = !result?.isError ? diffOf(result?.details) : undefined
  const written = block.name === 'write' && typeof args.content === 'string' ? args.content : undefined
  const stat = diff ? diffStat(diff) : undefined
  // A thread the call is about: the one it started, read or messaged, named as itself.
  const other = block.name === 'thread_start' ? (result?.details as { id?: string } | undefined)?.id : block.name?.startsWith('thread_') && typeof args.id === 'string' ? args.id : undefined
  return (
    <details className={`step step--${state}`}>
      <summary className="row">
        <Chevron />
        {state === 'working' ? <StatusGlyph status={{ state }} /> : <Icon name={block.name ?? ''} />}
        <span className="row__label">{verbOf(block.name ?? '', state)}</span>
        {other ? <ThreadRef machine={here.machine.id} id={other} className="row__thread" />
          : block.name === 'thread_start' ? <span className="row__arg">{String(args.title ?? 'a thread')}</span>
          : block.name === 'thread_archive' ? <span className="row__arg">this thread</span>
          : block.name !== 'thread_list' && <span className="row__arg" title={summaryOf(block.name ?? '', args)}>{summaryOf(block.name ?? '', args)}</span>}
        {stat && <span className="row__meta"><Stat {...stat} /></span>}
        {written !== undefined && <span className="row__meta">{lineCount(written)} lines</span>}
      </summary>
      {diff ? <Diff diff={diff} />
        : written !== undefined ? <Output text={written} />
        // A thread started or messaged is named in the row; what the call said back only repeats it.
        : other && state === 'done' && block.name !== 'thread_read' ? null
        : output ? <Output text={output} className={state === 'error' ? 'is-error' : ''} /> : null}
    </details>
  )
}

/** A tool's error as the harness wraps it (`<harness>[error] …</harness>`), as just the message. */
const unwrap = (text: string) => text.replace(/^\s*<harness>\s*(?:\[error\]\s*)?([\s\S]*?)\s*<\/harness>\s*$/, '$1')

/** What a call is about, in a line: the command, the path, else its arguments. */
function summaryOf(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  if (typeof args.pattern === 'string') return args.pattern
  return name ? JSON.stringify(args) : ''
}

const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length
const diffOf = (details: unknown) => typeof (details as { diff?: unknown } | undefined)?.diff === 'string' ? (details as { diff: string }).diff : undefined
function diffStat(diff: string) {
  const lines = diff.split('\n')
  return { added: lines.filter((l) => l.startsWith('+')).length, removed: lines.filter((l) => l.startsWith('-')).length }
}

/** A small, static glyph per kind of row: thinking, a page to read, a prompt to run, a pencil, a new page. */
const ROW_ICONS: Record<string, PhosphorIcon> = {
  thinking: SparkleIcon, read: FileTextIcon, bash: TerminalIcon, edit: PencilSimpleIcon, write: FilePlusIcon,
  thread_start: ArrowElbowDownRightIcon, thread_read: ChatCircleIcon, thread_send: ChatCircleIcon, thread_list: ChatsCircleIcon,
  thread_archive: ArchiveIcon,
}
function Icon({ name }: { name: string }) {
  const Glyph = ROW_ICONS[name] ?? WrenchIcon
  return <Glyph className="row__icon" size={14} aria-hidden />
}

/** An edit's diff, as the edit tool reports it: `+12 added`, `-12 removed`, ` 12 context`, and `...` between hunks. */
function Diff({ diff }: { diff: string }) {
  // The tool numbers context and removed lines by the old file, added lines by the new one. Both columns show:
  // the old number (context, removed) and the new one (context shifted by what changed above it, added).
  const [all, setAll] = useState(false)
  let shift = 0
  const lines = diff.split('\n').map((line) => {
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : /^\s*\.\.\.\s*$/.test(line) ? 'gap' : 'ctx'
    const match = /^[+\- ](\s*\d+) (.*)$/.exec(line)
    const n = match ? Number(match[1]) : undefined
    const old = n === undefined || kind === 'add' ? '' : String(n)
    const next = n === undefined || kind === 'del' ? '' : kind === 'add' ? String(n) : String(n + shift)
    if (kind === 'add') shift++
    if (kind === 'del') shift--
    return { kind, old, next, text: match ? match[2]! : kind === 'gap' ? '⋯' : line }
  })
  const long = lines.length > CAP * 2
  return (
    <div className="step__output step__diff">
      <Scroll>
        {(long && !all ? lines.slice(0, CAP * 2) : lines).map((line, index) => (
          <span key={index} className={`diff__line diff__line--${line.kind}`}>
            <span className="diff__num">{line.old}</span>
            <span className="diff__num">{line.next}</span>
            <span className="diff__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span className="diff__text">{line.text}</span>
          </span>
        ))}
      </Scroll>
      {long && <button type="button" className="step__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  )
}

function Composer({ machine, thread, busy, onJump }: { machine: MachineEntry; thread: ThreadInfo; busy: boolean; onJump?: () => void }) {
  const { openSettings: onOpenSettings } = useShell()
  const dispatch = useRegistry().router.dispatch
  const [claims, setClaims] = useState<ComposerClaim[]>([])
  const register = useMemo(() => (claim: ComposerClaim) => {
    setClaims((list) => [...list, claim])
    return () => setClaims((list) => list.filter((c) => c !== claim))
  }, [])
  const claim = claims.at(-1)
  // A draft per thread, kept until it's sent: switching threads or reloading doesn't lose it.
  const [text, setText] = useLocalState(`draft.${machine.id}.${thread.id}`, '')
  const [error, setError] = useState<{ kind?: string; message: string }>()
  const input = useRef<HTMLTextAreaElement>(null)
  // Archived, it can be read, not written to, until it's brought back (the Unarchive button where Send would be).
  const archived = Boolean(thread.archived)
  const disabled = machine.state !== 'connected' || archived
  useEffect(() => { input.current?.focus() }, [thread.id])
  // Files going with the next message: picked, dropped on the composer or pasted into it.
  const [files, setFiles] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => { setFiles([]) }, [thread.id])
  const attach = async (list: FileList | File[]) => {
    try {
      const read = await Promise.all([...list].map(readAttachment))
      setFiles((was) => [...was, ...read])
      setError(undefined)
    } catch (e) { setError({ message: (e as Error).message }) }
  }

  // While the agent works, ⏎ steers it (the message joins the running work after its current step) and ⌃⏎ queues
  // the message for when it's done.
  // Completing a word as it's typed, as extensions offer (`$co` → a skill, see composer.ts): ↑↓ pick, ⇥ or ⏎ takes
  // one, esc leaves the word as typed.
  const registry = useRegistry()
  useSyncExternalStore(registry.subscribe, () => registry.version)
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [dismissed, setDismissed] = useState<number>()
  const found = claim ? undefined : completing(completionsIn(registry, { machine: machine.id, thread }), text, caret)
  const word = found?.word
  // What the provider offered for the word, kept while it's asked again as the word grows (see menuFor).
  const [offered, setOffered] = useState<Offered>()
  useEffect(() => {
    if (!found) return setOffered(undefined)
    return askFor(found, { machine, thread }, setOffered)
  }, [found?.provider, JSON.stringify(word), machine.id, thread.id])
  const menu = menuFor(found, offered, dismissed)
  useEffect(() => { setPick(0) }, [word?.query, word?.start])
  useEffect(() => { if (!word) setDismissed(undefined) }, [word === undefined])
  // What an extension above offers, picked from with ←/→ while the box is empty, and what it puts in.
  const [offers, setOffers] = useState<{ messages: string[]; picked: number }>({ messages: [], picked: 0 })
  const offering = !claim && !text && !busy && offers.messages.length > 0
  const suggested = offering ? offers.messages[offers.picked] : undefined
  const suggest = useCallback((messages: string[] | undefined) => setOffers({ messages: messages ?? [], picked: 0 }), [])
  const composer = useMemo<Composer>(() => ({
    text,
    fill(next) {
      setText(next)
      setCaret(next.length)
      requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.length, next.length) })
    },
    suggest,
    picked: offering ? offers.picked : undefined,
  }), [text, setText, suggest, offering, offers.picked])
  const take = (item: Completion) => {
    if (!word) return
    const next = complete(text, caret, word.start, item.insert)
    setText(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => { input.current?.setSelectionRange(next.caret, next.caret); input.current?.focus() })
  }

  /** Send what the box holds (`typed`: a suggestion picked instead). */
  const send = async (whenBusy: 'steer' | 'followUp' = 'steer', typed?: string) => {
    // What the box holds now: a keypress straight after typing can come before the typing's render.
    const value = (typed ?? input.current?.value ?? text).trim()
    const sending = claim ? [] : files
    if (!value && !sending.length) return
    setText('')
    setFiles([])
    setError(undefined)
    try {
      if (claim) { await claim.submit(value); return }
      await dispatch('thread.submit', {
        id: thread.id, text: value, ...(sending.length ? { attachments: sending } : {}), requestId: crypto.randomUUID(), ...(busy ? { whenBusy } : {}),
      }, { machine: machine.id, source: 'composer' })
    } catch (error) {
      setText(value)
      setFiles(sending)
      setError(error as { kind?: string; message: string })
    }
  }
  // ⌃1–⌃9 send that offer, wherever the focus is in this thread's view (its column and the panes beside it).
  const sendRef = useRef(send)
  sendRef.current = send
  const numbered = offering ? offers.messages : undefined
  useEffect(() => {
    if (!numbered) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      const digit = ctrlDigit(event)
      const message = digit === undefined ? undefined : numbered[digit - 1]
      if (!message || event.defaultPrevented || event.repeat) return
      const view = input.current?.closest('.panes') ?? input.current?.closest('.thread')
      if (event.target !== document.body && !(event.target instanceof Node && view?.contains(event.target))) return
      event.preventDefault()
      void sendRef.current('steer', message)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [numbered])
  const abort = () => dispatch('thread.abort', { id: thread.id }, { machine: machine.id, source: 'composer' })
  const sendable = Boolean(text.trim()) || (!claim && files.length > 0)
  const onKeyDown = (event: KeyboardEvent) => {
    if (claim?.keyDown?.(event, text)) { event.preventDefault(); return }
    if (menu && word && !event.metaKey && !event.altKey && !event.ctrlKey) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPick((pick + (event.key === 'ArrowDown' ? 1 : -1) + menu.length) % menu.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); take(menu[pick] ?? menu[0]!); return }
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(word.start); return }
    }
    if (suggested && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const by = event.key === 'ArrowRight' ? 1 : -1
        setOffers((o) => ({ ...o, picked: (o.picked + by + o.messages.length) % o.messages.length }))
        return
      }
      if (event.key === 'Tab') { event.preventDefault(); composer.fill(suggested); return }
      if (event.key === 'Enter') { event.preventDefault(); void send('steer', suggested); return }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event.ctrlKey ? 'followUp' : 'steer') }
    if (event.key === 'Escape' && busy) { event.preventDefault(); void abort() }
    // Esc otherwise leaves the prompt for the thread above it: to read, and scroll from the keyboard.
    else if (event.key === 'Escape') { event.preventDefault(); transcriptOf(event.currentTarget)?.focus({ preventScroll: true, focusVisible: true }) }
  }
  return (
    <ClaimContext.Provider value={register}>
    <ComposerContext.Provider value={composer}>
    <div className={`dock ${dragging ? 'is-dropping' : ''}`}
      onDragOver={(e) => { if (!claim && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
      onDrop={(e) => { setDragging(false); if (!claim && e.dataTransfer.files.length) { e.preventDefault(); void attach(e.dataTransfer.files) } }}>
    {/* Over the box: back to the end, when you've scrolled away from it. */}
    <div className="dock__bar">
      {onJump && (
        <Button className="dock__pill dock__jump" onClick={onJump}>
          <ArrowDownIcon size={13} aria-hidden />
          Jump to bottom
        </Button>
      )}
    </div>
    <div className="dock__above"><Slot name="composer.above" props={{ machine, thread }} /></div>
    <div className="dock__box">
    {files.length > 0 && !claim && (
      <div className="composer__files">
        {files.map((file, index) => (
          <span key={`${file.name}-${index}`} className="attachment">
            {file.mimeType.startsWith('image/') ? <img src={`data:${file.mimeType};base64,${file.data}`} alt="" /> : <span className="attachment__icon"><FileIcon size={14} aria-hidden /></span>}
            <span className="attachment__name">{file.name}</span>
            <button className="attachment__remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((was) => was.filter((_, i) => i !== index))}>×</button>
          </span>
        ))}
      </div>
    )}
    {error && (
      <div className="composer__error">
        {error.kind === 'no_model' ? <>No model is set up on {machine.label}. <Button onClick={onOpenSettings}>Open Settings</Button></> : error.message}
      </div>
    )}
    {menu && (
      <div className="completions" role="listbox" aria-label={found!.provider.title}>
        {menu.map((item, index) => (
          <div key={`${item.label}-${index}`} role="option" aria-selected={index === pick} className={`completions__item ${index === pick ? 'is-active' : ''}`}
            onMouseEnter={() => setPick(index)} onMouseDown={(e) => { e.preventDefault(); take(item) }}>
            <span className="completions__label">{item.label}</span>
            {item.detail && <span className="completions__detail">{item.detail}</span>}
          </div>
        ))}
      </div>
    )}
    <div className="composer">
      <TextArea ref={input} rows={1} value={text} disabled={disabled} onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart) }} onKeyDown={onKeyDown}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => { if (!claim && e.clipboardData.files.length) { e.preventDefault(); void attach(e.clipboardData.files) } }}
        placeholder={archived ? 'Archived: read only' : disabled ? `${machine.label} is ${machine.state}` : claim ? claim.placeholder : busy ? 'Steer the agent…' : suggested ? `${suggested}  ⏎` : 'Reply…'} />
      <div className="composer__actions">
        {/* In the box at its end: attach, then (while the agent works) Queue and Stop, then Send, Steer or Answer: one key, ⏎. */}
        {!claim && !archived && (
          <>
            <IconButton label="Attach files" className="composer__icon" disabled={disabled} onClick={() => picker.current?.click()}>
              <PaperclipIcon size={15} aria-hidden />
            </IconButton>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = '' }} />
          </>
        )}
        {busy && !claim && sendable && <Button className="composer__pill" disabled={disabled} onClick={() => void send('followUp')}>Queue <kbd>⌃⏎</kbd></Button>}
        {busy && !claim && (
          <Button className="composer__pill composer__stop" onClick={() => void abort()}>
            <span className="composer__stop-mark" aria-hidden />Stop <kbd>esc</kbd>
          </Button>
        )}
        {archived
          ? <UnarchiveButton machine={machine} thread={thread} className="composer__unarchive" />
          : (!busy || claim || sendable) && (
            <IconButton label={`${claim ? 'Answer' : busy ? 'Steer' : 'Send'} (⏎)`} aria-label={claim ? 'Answer' : busy ? 'Steer' : 'Send'} className="composer__send" disabled={disabled || !sendable} onClick={() => void send()}>
              {busy && !claim ? <ArrowElbowRightIcon size={15} weight="bold" aria-hidden /> : <ArrowUpIcon size={15} weight="bold" aria-hidden />}
            </IconButton>
          )}
      </div>
    </div>
    </div>
    </div>
    </ComposerContext.Provider>
    </ClaimContext.Provider>
  )
}

/** Open a pane beside the thread: the kinds that show something without being told what (Changes, a profile's own). */
export function PaneMenu({ machine, thread, add = false }: { machine: MachineEntry; thread: ThreadInfo; add?: boolean }) {
  const registry = useRegistry()
  const kinds = paneMenu(registry, { machine: machine.id, thread })
  if (!kinds.length) return null
  const open = (kind: string) => void registry.router.dispatch('pane.open', { id: thread.id, kind }, { machine: machine.id, source: 'header' })
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton label="Open a pane beside" className="thread__panes" />}>
        {add ? <PlusIcon size={14} aria-hidden /> : <ColumnsIcon size={18} aria-hidden />}
      </Menu.Trigger>
      <Menu.Popup align="end">
        {kinds.map(({ kind, title }) => <Menu.Item key={kind} onClick={() => open(kind)}>{title}</Menu.Item>)}
      </Menu.Popup>
    </Menu.Root>
  )
}

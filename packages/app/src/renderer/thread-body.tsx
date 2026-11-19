// A thread's transcript and composer, as the thread's column (and a "thread" pane) draws them: scrolled back a page at a
// time, kept at its end as things come in, and its links followed beside it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EntryRecord, InboxState, LiveState } from '@earendil-works/pi-durable'
import type { ThreadInfo } from '@superego/protocol'
import type { MachineEntry } from '../shared/bridge.ts'
import { machine as client, useThreadView } from './client.ts'
import { Images, imagesIn } from './Markdown.tsx'
import { collector, LinkPlace, useLinkPlace, type LinkPlaceValue } from './links.tsx'
import { Transcript } from './transcript.tsx'
import { ComposerView } from './composer-view.tsx'

/** How far from its end a transcript still counts as at its end, and follows what comes in. */
const PINNED = 80
/** Far enough up from the end to be offered the way back down. */
const isAway = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight > 200

/** A thread's transcript and composer. Also what a "thread" pane draws. */
export function ThreadBody({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const watched = useThreadView(machine.id, machine.state === 'connected', thread.id)
  const live = watched?.docs['pi.live'] as LiveState | undefined
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  /** Where its end was when last kept there. */
  const end = useRef(0)
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
  // Only as entries come and go: what streams in (the live run) changes the watch, not them, and a transcript drawn
  // from the same entries draws again only what's new.
  const entries = useMemo(() => [...seen.current.values()].sort((a, b) => (a.id as number) - (b.id as number)), [watched?.entries, watched?.before, older])
  const atStart = watched !== undefined && (watched.before === undefined || (entries[0] !== undefined && !older.more && !older.loading))
  const view = useMemo(() => watched && { ...watched, entries, before: atStart ? undefined : entries[0]?.id }, [watched, entries, atStart])
  const keep = useRef<{ height: number; top: number }>(undefined)
  const loadOlder = useCallback(() => {
    const el = scroller.current
    const first = entries[0]
    if (!el || !first || atStart || older.loading) return
    setOlder((o) => ({ ...o, loading: true }))
    void client(machine.id).call('thread.history', { thread: thread.id, before: first.id as number, limit: 50 }).then(({ entries: page, more }) => {
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
      if (pinned.current) { el.scrollTop = el.scrollHeight; end.current = el.scrollTop }
      // Its end can move away without a scroll (a reply coming in below where it was left): offer the way back then too.
      setAway(isAway(el))
    })
    observer.observe(column)
    observer.observe(dock)
    return () => observer.disconnect()
  }, [])

  // Where its Markdown's links are; the transcript's are kept for ⌃O's list.
  const links = useLinkPlace(machine, thread, { source: 'thread' })
  const transcriptLinks = useMemo<LinkPlaceValue>(() => ({ ...links, collect: collector(machine.id, thread.id) }), [links])

  return (
    <LinkPlace.Provider value={links}>
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
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED
          if (atEnd) end.current = el.scrollHeight - el.clientHeight
          // Not scrolled up from where its end was: the transcript shrinking moves it too, heard only once it's grown back.
          pinned.current = atEnd || (pinned.current && el.scrollTop >= end.current - PINNED)
          setAway(isAway(el))
          el.parentElement?.classList.toggle('is-scrolled', el.scrollTop > 8)
          if (el.scrollTop < el.clientHeight) loadOlder()
        }}>
        <div className="thread__column">
          <LinkPlace.Provider value={transcriptLinks}>
            {view ? <Transcript machine={machine} thread={thread} view={view} live={live} /> : <div className="transcript__more">Loading…</div>}
          </LinkPlace.Provider>
        </div>
      </div>
      <ComposerView machine={machine} thread={thread} busy={Boolean(live?.run)} inbox={watched?.docs['pi.inbox'] as InboxState | undefined} onJump={away ? jumpToEnd : undefined} />
    </div>
    </Images.Provider>
    </LinkPlace.Provider>
  )
}

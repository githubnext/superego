// A phone's thread sheet: what the title bar holds wide, as a menu up from the foot. One row each, an icon and what it
// says (and a detail after, where there's one): the thread's own (its profile, where it came from, extensions' chips and
// header views), renaming (the title at its top becomes a field), pinning and archiving, the panes to open beside it; under them, the views the layout puts beside the
// thread, which are panels, not rows.
import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { ThreadInfo } from '@superego/protocol'
import { ArchiveIcon, ArrowCounterClockwiseIcon, ArrowElbowDownRightIcon, BaseUI, IdentificationBadgeIcon, PencilSimpleIcon, popupFocus, PushPinIcon } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import type { ViewProps } from './extension-api.ts'
import { useRegistry, type Registry } from './registry.tsx'
import { paneMenu, PlacedViews, Slot, useLayout, viewsIn, ViewScopeProvider } from './placement.tsx'
import { withMenuButton } from './view-menu.tsx'
import { Contained } from './contained.tsx'
import { controlOf } from './overflow.tsx'
import { ProfileBadge } from './profile-card.tsx'
import { ThreadRef } from './thread-ref.tsx'
import { isPinned } from './pins.ts'
import { useProjects } from './state.tsx'
import { startRename, useRenaming } from './rename.ts'
import { TitleField } from './thread-header.tsx'

type Icon = ComponentType<{ size?: number; 'aria-hidden'?: boolean }>

/**
 * Over the thread, from the foot: Base UI's Drawer, back down with a swipe, a tap beside it, or Escape (a menu open from
 * it closes first). Drawn into the window (`container`), under its styles. Choosing a row closes it, unless the row
 * opens something of its own from there (a popover, the details shown under it).
 */
export function ThreadSheet({ machine, thread, open, onOpenChange, handle, container }: {
  machine: MachineEntry; thread: ThreadInfo; open: boolean; onOpenChange(open: boolean): void
  handle: BaseUI.Drawer.Handle<unknown>; container: HTMLElement | null
}) {
  const registry = useRegistry()
  const where = { machine: machine.id, thread }
  const { placed } = useLayout(where)
  const kinds = paneMenu(registry, placed, where)
  const besides = viewsIn(registry, placed, 'beside', where)
  const pinned = isPinned(useProjects().pins, { machine: machine.id, thread: thread.id })
  const renaming = useRenaming() === `${machine.id}/${thread.id}`
  const popup = useRef<HTMLDivElement>(null)
  // Closed by a pane opened from it, the focus is the pane's to take, not the title's again.
  const opened = useRef(false)
  const run = (id: string, params: Record<string, unknown>, options: { machine?: string } = { machine: machine.id }) => {
    onOpenChange(false)
    void registry.router.dispatch(id, params, { ...options, source: 'sheet' }).catch((error) => console.error(error))
  }
  const openPane = (kind: string) => {
    opened.current = true
    run('pane.open', { thread: thread.id, kind })
  }
  const close = () => onOpenChange(false)
  return (
    <BaseUI.Drawer.Root open={open} onOpenChange={onOpenChange} handle={handle} swipeDirection="down">
      <BaseUI.Drawer.Portal container={container}>
        <BaseUI.Drawer.Backdrop className="app__scrim app__scrim--sheet" />
        <BaseUI.Drawer.Viewport className="app__sheet">
          {/* Opened by a finger, the sheet holds the focus itself (no keyboard over it); from the keyboard, its first row. */}
          <BaseUI.Drawer.Popup ref={popup} className="thread-sheet" aria-label={thread.title}
            initialFocus={popupFocus(popup)}
            finalFocus={() => { const back = !opened.current; opened.current = false; return back }}>
            <BaseUI.Drawer.Content className="app__drawer-content">
              <div className="thread-sheet__head">
                {renaming
                  ? <TitleField machine={machine} thread={thread} className="thread-sheet__field" source="sheet" onEnter={close} />
                  : <div className="thread-sheet__title">{thread.title}</div>}
                <div className="thread-sheet__project">{machine.id !== 'local' && `${machine.label} · `}{thread.project.name}</div>
              </div>
              <div className="thread-sheet__group" role="group" aria-label="Thread">
                {thread.profile && (
                  <HostedItem id="profile" icon={IdentificationBadgeIcon} title="Profile" onDone={close}>
                    <ProfileBadge machine={machine} thread={{ ...thread, profile: thread.profile }} />
                  </HostedItem>
                )}
                {thread.parent && (
                  <HostedItem id="parent" icon={ArrowElbowDownRightIcon} title="From" of=".thread-ref__title" onDone={close}>
                    <ThreadRef machine={machine.id} id={thread.parent} />
                  </HostedItem>
                )}
                <Slot name="header.chips" props={{ machine, thread }} frame={(key, drawn) => (
                  <HostedItem key={key} id={`chip:${key}`} onDone={close}>{drawn}</HostedItem>
                )} />
                <PlacedViews place="header" machine={machine} thread={thread} frame={(view, drawn) => (
                  <HostedItem id={`view:${view.id}`} icon={view.icon} title={view.title} said={<Said view={view} machine={machine} thread={thread} />} onDone={close}>
                    {drawn}
                  </HostedItem>
                )} />
              </div>
              {!thread.hidden && (
                <div className="thread-sheet__group" role="group" aria-label="Actions">
                  {!renaming && <SheetItem id="rename" icon={PencilSimpleIcon} onClick={() => startRename(machine.id, thread.id)}>Rename</SheetItem>}
                  {!thread.archived && (
                    <SheetItem id="pin" icon={PushPinIcon} onClick={() => run(pinned ? 'thread.unpin' : 'thread.pin', { machine: machine.id, thread: thread.id }, {})}>
                      {pinned ? 'Unpin' : 'Pin'}
                    </SheetItem>
                  )}
                  {thread.archived
                    ? <SheetItem id="unarchive" icon={ArrowCounterClockwiseIcon} onClick={() => run('thread.unarchive', { thread: thread.id })}>Unarchive</SheetItem>
                    : <SheetItem id="archive" icon={ArchiveIcon} onClick={() => run('thread.archive', { thread: thread.id })}>Archive</SheetItem>}
                </div>
              )}
              {kinds.length > 0 && (
                <div className="thread-sheet__group" role="group" aria-labelledby="thread-sheet-panes">
                  <div className="superego-menu__label" id="thread-sheet-panes">Open beside</div>
                  {kinds.map(({ kind, title, icon }) => <SheetItem key={kind} id={`pane:${kind}`} icon={icon} onClick={() => openPane(kind)}>{title}</SheetItem>)}
                </div>
              )}
              {besides.length > 0 && <div className="thread-sheet__beside"><PlacedViews place="beside" machine={machine} thread={thread} frame={withMenuButton('beside', where)} /></div>}
            </BaseUI.Drawer.Content>
          </BaseUI.Drawer.Popup>
        </BaseUI.Drawer.Viewport>
      </BaseUI.Drawer.Portal>
    </BaseUI.Drawer.Root>
  )
}

/** A row: its icon (a blank as wide, without), what it says, and a detail at its end. */
function SheetItem({ id, icon: Icon, hint, checked, disabled, onClick, children }: {
  id: string; icon?: Icon | undefined; hint?: ReactNode; checked?: boolean; disabled?: boolean; onClick(): void; children: ReactNode
}) {
  return (
    <button type="button" className="superego-menu__item thread-sheet__item" data-item={id} disabled={disabled}
      aria-pressed={checked} onClick={onClick}>
      <span className="superego-menu__text thread-sheet__label">
        {Icon ? <Icon size={18} aria-hidden /> : <span className="thread-sheet__blank" />}
        <span className="thread-sheet__words">{children}</span>
      </span>
      {(hint || checked) && <span className="superego-menu__hint thread-sheet__hint">{hint && <span className="thread-sheet__detail">{hint}</span>}{checked && <span className="superego-menu__check">✓</span>}</span>}
    </button>
  )
}

/**
 * A row for something the title bar draws as it is (a chip, the profile's badge, an extension's header view): drawn
 * here too, hidden under the row, and the row says what it shows. Choosing the row clicks it there, as the title bar's
 * ··· does, so its popover or menu opens from the row. What the row says: `said`'s text ("Model: claude-opus",
 * split at the colon into the row and its detail), else `title` with what it shows (of its part `of`) as the detail,
 * else what it shows. One that draws nothing (a view with nothing to say for this thread) has no row.
 *
 * The sheet stays open for what opens from the row or shows under it (a control with a popup or pressed state), and
 * closes for the rest (`onDone`).
 */
function HostedItem({ id, icon, title, of, said, onDone, children }: {
  id: string; icon?: Icon | undefined; title?: string; of?: string; said?: ReactNode; onDone(): void; children: ReactNode
}) {
  const host = useRef<HTMLSpanElement>(null)
  const saidRef = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState<{ text: string; said: string; control: boolean; pressed: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const read = () => {
      const control = controlOf(el)
      const text = clean(((of && el.querySelector(of)) || el).textContent)
      const next = { text, said: clean(saidRef.current?.textContent), control: Boolean(control), pressed: control?.getAttribute('aria-pressed') === 'true' }
      setShown((was) => was && was.text === next.text && was.said === next.said && was.control === next.control && was.pressed === next.pressed ? was : next)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-pressed'] })
    if (saidRef.current) observer.observe(saidRef.current, { subtree: true, childList: true, characterData: true })
    return () => observer.disconnect()
  }, [of])
  const empty = !shown || (!shown.text && !shown.control)
  const colon = shown?.said.indexOf(': ') ?? -1
  const [label, hint] = shown?.said
    ? colon > 0 ? [shown.said.slice(0, colon), shown.said.slice(colon + 2)] : [shown.said, undefined]
    : title ? [title, shown?.text && shown.text !== title ? shown.text : undefined] : [shown?.text, undefined]
  const choose = () => {
    const control = host.current && controlOf(host.current)
    if (!control) return
    const stays = control.hasAttribute('aria-haspopup') || control.hasAttribute('aria-expanded') || control.hasAttribute('aria-pressed')
    control.click()
    if (!stays) onDone()
  }
  return (
    <div className="thread-sheet__hosted" hidden={empty}>
      <span ref={host} className="thread-sheet__host" aria-hidden>{children}</span>
      {said && <span ref={saidRef} className="thread-sheet__host" aria-hidden>{said}</span>}
      <SheetItem id={id} icon={icon} hint={hint} checked={shown?.pressed} disabled={!shown?.control} onClick={choose}>{label}</SheetItem>
    </div>
  )
}

const clean = (text: string | null | undefined) => text?.replace(/\s+/g, ' ').trim() ?? ''

/** What a header view's row says: its `menuItem` ("Model: claude-opus"), drawn to be read. */
function Said({ view, machine, thread }: { view: Registry['views'][number]; machine: MachineEntry; thread: ThreadInfo }) {
  const Item = view.menuItem as ComponentType<ViewProps> | undefined
  if (!Item) return null
  return <ViewScopeProvider value={{ machine: machine.id, thread }}><Contained name={view.owner.extension} scope={view.owner.profile} inline><Item place="header" machine={machine} thread={thread} /></Contained></ViewScopeProvider>
}

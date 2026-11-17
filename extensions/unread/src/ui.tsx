// unread, UI half: what agents have for you that you haven't seen (a result, a failure, a question). ⌘U lists them, the
// most pressing first, each saying what it wants in a word (Question, Permission, Failed, Done), to type a few letters of one and go there (after Fut's); with none, it says so and lists
// nothing. A bell with how many, coloured by the most pressing (as Fut shows its waiting agents), opens the same list:
// a view (`unread.bell`), in the rail while there's no space (a sidebar shows its own), and beside Settings in a
// phone's drawer. ⌘. goes to the next one, in every project or the one you're in.
import { useEffect } from 'react'
import { defineAction, defineUiExtension, Picker, unreadList, useMachines, useProjects, useSelection, type Store, type ViewProps } from '@superego/app/ui'
import { rollup } from '@superego/protocol'
import { BellIcon, Button, StatusGlyph, StatusWord } from '@superego/ui'
import { about, SCOPE, type Scope } from './shared.ts'
import { filterUnread, nextUnread, shorten, type Unread } from './unread.ts'
import './styles.css'

/** The list: shown, closed, or (asked for with nothing unread) a brief "Nothing unread" instead. */
type Shown = 'open' | 'closed' | 'none'
/** Whether the list is open (set in setup). */
let shown: Store<Shown>

export default defineUiExtension({
  ...about,
  setup(superego) {
    shown = superego.store<Shown>('list', 'closed')
    superego.slot('overlay', UnreadOverlay)
    superego.appSettings({
      id: 'unread', title: 'Unread', order: 61,
      settings: [{ key: SCOPE, title: 'Next unread thread (⌘.)', default: 'all', type: 'choice', options: [
        { value: 'all', label: 'In every project' }, { value: 'project', label: 'In this project' },
      ] }],
    })
    superego.view('unread.bell', {
      title: 'Unread', icon: BellIcon, context: 'window', fits: ['rail', 'drawer'], withoutSpaces: 'rail', narrow: 'drawer', component: UnreadButton,
    })
    superego.action(defineAction({
      id: 'unread.list', title: 'Unread threads…', keys: 'mod+u',
      run: (_params, c) => shown.set((was) => was === 'open' ? 'closed' : unreadList(c.projects, c.selection).length ? 'open' : 'none'),
    }))
    superego.action(defineAction({
      id: 'unread.next', title: 'Next unread thread', keys: 'mod+.',
      run: (_params, c) => {
        const next = nextUnread(c.projects, c.selection, c.appSetting<Scope>(SCOPE) ?? 'all')
        if (next) c.select(next)
      },
    }))
  },
})

function UnreadButton({ place }: ViewProps<'window'>) {
  const { projects } = useProjects()
  const { selection } = useSelection()
  const list = unreadList(projects, selection)
  if (!list.length) return null
  const top = rollup(list.map((w) => w.thread.status))
  const label = `${list.length} unread`
  return (
    <Button className={`unread-button unread-button--${top.state} ${place === 'rail' ? 'unread-button--rail' : ''}`} aria-label={label} title={label}
      onClick={() => shown.set((was) => was === 'open' ? 'closed' : 'open')}>
      <BellIcon size={15} aria-hidden />
      <span className="unread-button__count">{list.length}</span>
    </Button>
  )
}

function UnreadOverlay() {
  const state = shown.use()
  if (state === 'none') return <NothingUnread onClose={() => shown.set('closed')} />
  if (state === 'open') return <UnreadList onClose={() => shown.set('closed')} />
  return null
}

/** Said for a moment where the list would be, instead of an empty one: gone by itself, or at a key or a click. */
function NothingUnread({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const done = setTimeout(onClose, 1500)
    window.addEventListener('keydown', onClose)
    window.addEventListener('pointerdown', onClose)
    return () => { clearTimeout(done); window.removeEventListener('keydown', onClose); window.removeEventListener('pointerdown', onClose) }
  }, [])
  return <div className="unread-none" role="status">Nothing unread</div>
}

function UnreadList({ onClose }: { onClose(): void }) {
  const { projects } = useProjects()
  const { selection, select } = useSelection()
  const several = useMachines().filter((m) => m.state !== 'disabled').length > 1
  // Live: one seen elsewhere, or a new one, changes the list while it's open.
  const list = unreadList(projects, selection)
  const go = ({ machine, thread }: Unread) => { onClose(); select({ machine, thread: thread.id }) }
  return (
    <Picker<Unread> label="Unread threads" className="unread-list" placeholder="Go to an unread thread" items={list} filter={filterUnread}
      onClose={onClose} onPick={go} empty={list.length ? 'Nothing matches' : 'Nothing unread'}
      row={({ machine, project, thread }) => ({
        key: `${machine}/${thread.id}`,
        glyph: <StatusGlyph status={thread.status} />,
        title: (
          <>
            <span className="unread-list__head">
              <span className="unread-list__title">{thread.title}</span>
              <span className="unread-list__where">{several || machine !== 'local' ? `${project.name} · ${project.machine.label}` : project.name}</span>
            </span>
            {thread.status.msg && <span className="unread-list__msg">{shorten(thread.status.msg)}</span>}
          </>
        ),
        detail: <StatusWord status={thread.status} />,
      })} />
  )
}

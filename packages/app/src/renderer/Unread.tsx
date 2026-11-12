// Beside Settings, when agents have something you haven't seen (a result, a failure, a question): a bell and how many,
// coloured by the most pressing (as Fut shows its waiting agents). It opens a list of them, the most pressing first;
// picking one goes there. Nothing shows when there's nothing unread.
import { rollup, type Status } from '@superego/protocol'
import { BellIcon, Button, Menu, StatusGlyph } from '@superego/ui'
import { unread } from './sessions.ts'
import { useSelection, useSessions } from './state.tsx'

const PRIORITY: Record<Status['state'], number> = { blocked: 4, error: 3, done: 2, working: 1, idle: 0 }

export function UnreadButton({ side = 'top' }: { side?: 'top' | 'right' }) {
  const { sessions } = useSessions()
  const { selection, select } = useSelection()
  // The thread you're looking at is being seen: it doesn't count.
  const waiting = sessions.flatMap((session) => session.threads
    .filter((thread) => unread(thread) && !(session.machine.id === selection?.machine && thread.id === selection.thread))
    .map((thread) => ({ session, thread })))
    .sort((a, b) => PRIORITY[b.thread.status.state] - PRIORITY[a.thread.status.state] || b.thread.activeAt - a.thread.activeAt)
  if (!waiting.length) return null
  const top = rollup(waiting.map((w) => w.thread.status))
  const label = `${waiting.length} unread`
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button className={`unread-button unread-button--${top.state}`} aria-label={label} title={label} />}>
        <BellIcon size={15} aria-hidden />
        <span className="unread-button__count">{waiting.length}</span>
      </Menu.Trigger>
      <Menu.Popup side={side} className="unread-menu">
        {waiting.map(({ session, thread }) => (
          <Menu.Item key={`${session.machine.id}/${thread.id}`} hint={session.name} onClick={() => select({ machine: session.machine.id, thread: thread.id })}>
            <span className="unread-menu__row"><StatusGlyph status={thread.status} /><span className="unread-menu__title">{thread.title}</span></span>
          </Menu.Item>
        ))}
      </Menu.Popup>
    </Menu.Root>
  )
}

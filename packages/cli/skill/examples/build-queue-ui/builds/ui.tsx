// builds, UI half: the thread's queue beside it, each build with Cancel while it's queued or running; ⌘⇧B shows or
// hides it there.
import { defineAction, defineUiExtension, has, PaneMessage, StatusGlyph, useDispatch, useValue, type ViewProps } from 'superego/ui'
import { about, QUEUE, VIEW, type Build } from './shared.ts'

const STATUS = { queued: 'idle', running: 'working', done: 'done', failed: 'error', cancelled: 'idle' } as const

function Queue({ machine, thread }: ViewProps<'thread'>) {
  // This thread's queue only: its scope of the value.
  const builds = useValue<Build[]>(machine, QUEUE, { scope: thread.id }) ?? []
  const dispatch = useDispatch()
  if (!has(machine, 'ext:builds@^1')) return <PaneMessage>No build queue on {machine.label}.</PaneMessage>
  if (!builds.length) return <PaneMessage>No builds queued.</PaneMessage>
  const cancel = (id: string) => void dispatch('builds.cancel', { thread: thread.id, id }, { machine: machine.id }).catch((error: Error) => console.error(error))
  return (
    <ul className="builds">
      {builds.map((build) => (
        <li key={build.id} className="builds__build">
          <StatusGlyph status={{ state: STATUS[build.state] }} />
          <code>{build.command}</code> <span className="builds__state">{build.state}</span>
          {(build.state === 'queued' || build.state === 'running') && <button type="button" onClick={() => cancel(build.id)}>Cancel</button>}
        </li>
      ))}
    </ul>
  )
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.view(VIEW, { title: 'Builds', context: 'thread', fits: ['beside', 'pane'], default: 'beside', component: Queue })
    // In this profile's threads: the queue beside the thread, or not.
    superego.action(defineAction({
      id: 'builds.toggle', title: 'Show or hide the build queue', keys: 'mod+shift+b',
      run: (_params, context) => context.dispatch('layout.place', { view: VIEW, place: 'beside' }),
    }))
  },
})

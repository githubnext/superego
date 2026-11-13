/// <reference path="./env.d.ts" />
// ego, UI half: Ego's button (`ego.button`: at the top of the rail, and at the foot of a phone's drawer) and "Ask Ego"
// in ⌘K, which open its thread on this computer (made the first time); and in its thread's title bar, Clear instead of
// archiving. Its thread is a hidden one: the window
// shows it while it's selected, as any.
import { defineAction, defineUiExtension, has, useApp, useDispatch, useMachines, useSelection, type ViewProps } from '@superego/app/ui'
import { agentName, type ThreadInfo } from '@superego/protocol'
import { BroomIcon, IconButton, LifebuoyIcon } from '@superego/ui'
import { about, ASK, CLEAR } from './shared.ts'

/** Open Ego's thread on this computer. */
const OPEN = 'ego.open'
const isEgo = (thread: ThreadInfo | undefined) => thread?.ext?.ego === true

export default defineUiExtension({
  ...about,
  setup(superego) {
    // A button, not a space: it shows a thread, and the sidebar keeps what it shows. First in the rail.
    superego.view('ego.button', {
      title: `Ask ${agentName(superego.app)}`, icon: LifebuoyIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10,
      component: EgoButton,
    })
    superego.view('ego.clear', { title: 'Clear', context: 'thread', fits: ['header'], default: 'header', component: ClearButton })
    superego.action(defineAction({
      id: OPEN, title: `Ask ${agentName(superego.app)}`,
      when: (c) => has(c.machines.find((m) => m.id === 'local'), 'ext:ego'),
      run: async (_p, c) => {
        const thread = await c.dispatch(ASK, {}, { machine: 'local', source: 'ego' }) as ThreadInfo
        c.select({ machine: 'local', thread: thread.id })
      },
    }))
  },
})

function EgoButton({ place }: ViewProps<'window'>) {
  const app = useApp()
  const dispatch = useDispatch()
  const local = useMachines().find((m) => m.id === 'local')
  const { selection, thread } = useSelection()
  if (!has(local, 'ext:ego')) return null
  const on = selection?.machine === 'local' && isEgo(thread)
  return (
    <IconButton label={`Ask ${agentName(app)}`} className={`app__rail-button ego__button ${on ? 'is-on' : ''}`} onClick={() => void dispatch(OPEN, {}, { source: place }).catch((error) => console.error(error))}>
      <LifebuoyIcon size={18} aria-hidden />
    </IconButton>
  )
}

/** Ego is kept, not archived: cleared, it starts empty again. */
function ClearButton({ machine, thread }: ViewProps<'thread'>) {
  const dispatch = useDispatch()
  if (!isEgo(thread)) return null
  return (
    <IconButton label="Clear" className="thread__clear" onClick={() => void dispatch(CLEAR, {}, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))}>
      <BroomIcon size={15} aria-hidden />
    </IconButton>
  )
}

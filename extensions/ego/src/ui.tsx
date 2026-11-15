/// <reference path="./env.d.ts" />
// ego, UI half: Ego's button (`ego.button`: at the top of the rail, and at the foot of a phone's drawer) and "Ask Ego"
// in ⌘K, which open its thread on the machine last chosen (this computer to start with; made the first time); and in
// its thread's title bar, Clear instead of archiving and, where more than one machine has an Ego, which one's this is,
// to switch to another's. Its thread is a hidden one: the window shows it while it's selected, as any. A message an
// outside agent sent it shows a chip saying so.
import { defineAction, defineUiExtension, has, useApp, useDispatch, useMachines, useSelection, type ViewProps } from '@superego/app/ui'
import { agentName, obj, opt, str, type ThreadInfo } from '@superego/protocol'
import { BroomIcon, IconButton, LifebuoyIcon, PlugsConnectedIcon, Select } from '@superego/ui'
import type { MachineEntry } from '@superego/app/ui'
import './styles.css'
import { about, ASK, CLEAR, outsideBlocks } from './shared.ts'

/** Open Ego's thread on a machine: the one given (then remembered), else the one last chosen, else this computer. */
const OPEN = 'ego.open'
const isEgo = (thread: ThreadInfo | undefined) => thread?.ext?.ego === true
/** The machines whose Ego the window can open now. */
const withEgo = (machines: MachineEntry[]) => machines.filter((m) => m.state === 'connected' && has(m, 'ext:ego'))
/** Where Ego opens without a machine named: the one last chosen while it has one, else this computer, else any. */
const egoMachine = (machines: MachineEntry[], chosen: string) => {
  const ones = withEgo(machines)
  return (ones.find((m) => m.id === chosen) ?? ones.find((m) => m.id === 'local') ?? ones[0])?.id
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    const chosen = superego.store<string>('ego.machine', 'local', { persist: true })
    // A button, not a space: it shows a thread, and the sidebar keeps what it shows. First in the rail.
    superego.view('ego.button', {
      title: `Ask ${agentName(superego.app)}`, icon: LifebuoyIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10,
      component: (props) => <EgoButton {...props} chosen={chosen.use()} />,
    })
    superego.view('ego.machine', { title: 'Machine', context: 'thread', fits: ['header'], default: 'header', component: MachineSwitch })
    superego.view('ego.clear', { title: 'Clear', context: 'thread', fits: ['header'], default: 'header', component: ClearButton })
    superego.composer.sentWith({
      read: (blocks) => { const at = outsideBlocks(blocks); return at.length ? { items: [true], blocks: at } : undefined },
      component: OutsideChip,
    })
    superego.action(defineAction({
      id: OPEN, title: `Ask ${agentName(superego.app)}`,
      params: obj({ machine: opt(str()) }),
      when: (c) => withEgo(c.machines).length > 0,
      run: async ({ machine }, c) => {
        const at = machine ?? egoMachine(c.machines, chosen.get())
        if (!at) return
        const thread = await c.dispatch(ASK, {}, { machine: at, source: 'ego' }) as ThreadInfo
        // Only a choice is remembered: one gone for now is opened again once it's back.
        if (machine) chosen.set(machine)
        c.select({ machine: at, thread: thread.id })
      },
    }))
  },
})

function EgoButton({ place, chosen }: ViewProps<'window'> & { chosen: string }) {
  const app = useApp()
  const dispatch = useDispatch()
  const machines = useMachines()
  const { thread } = useSelection()
  const at = egoMachine(machines, chosen)
  if (!at) return null
  const elsewhere = at !== 'local' && withEgo(machines).length > 1 ? machines.find((m) => m.id === at)?.label : undefined
  return (
    <IconButton label={`Ask ${agentName(app)}${elsewhere ? ` on ${elsewhere}` : ''}`} className={`app__rail-button ego__button ${isEgo(thread) ? 'is-on' : ''}`}
      onClick={() => void dispatch(OPEN, {}, { source: place }).catch((error) => console.error(error))}>
      <LifebuoyIcon size={18} aria-hidden />
    </IconButton>
  )
}

/** Whose Ego this is, where there's more than one: another picked opens that machine's. */
function MachineSwitch({ machine, thread }: ViewProps<'thread'>) {
  const dispatch = useDispatch()
  const machines = withEgo(useMachines())
  if (!isEgo(thread) || machines.length < 2) return null
  return (
    <Select className="ego__machine" aria-label="Machine" value={machine.id} options={machines.map((m) => ({ value: m.id, label: m.label }))}
      onChange={(id) => { if (id && id !== machine.id) void dispatch(OPEN, { machine: id }, { source: 'header' }).catch((error) => console.error(error)) }} />
  )
}

/** Ego is kept, not archived: cleared, it starts empty again. */
function ClearButton({ machine, thread }: ViewProps<'thread'>) {
  const dispatch = useDispatch()
  if (!isEgo(thread)) return null
  return (
    <IconButton label="Clear" className="ego__clear" onClick={() => void dispatch(CLEAR, {}, { machine: machine.id, source: 'header' }).catch((error) => console.error(error))}>
      <BroomIcon size={15} aria-hidden />
    </IconButton>
  )
}

/** Under a message an outside agent sent (`superego mcp`), not the user. */
function OutsideChip() {
  return (
    <span className="attachment ego__outside" title="Sent by an outside agent, over MCP">
      <span className="attachment__icon"><PlugsConnectedIcon size={13} aria-hidden /></span>
      <span className="attachment__name">Outside agent</span>
    </span>
  )
}

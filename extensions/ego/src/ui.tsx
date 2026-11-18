// ego, UI half: Ego's button (`ego.button`: at the top of the rail, and at the foot of a phone's drawer) and "Ask Ego"
// in ⌘K, which open its thread on the machine last chosen (this computer to start with; made the first time); and in
// its thread's title bar, Clear instead of archiving and, where more than one machine has an Ego, which one's this is,
// to switch to another's. Its thread is a hidden one: the window shows it while it's selected, as any. A message an
// outside agent sent it shows a chip saying so. On the first-launch page, a word on what to ask it for, and where it is.
import { Chip, defineAction, defineUiExtension, factsOf, has, RailButton, useApp, useDispatch, useMachines, useNarrow, useRailShortcut, useSelection, type Store, type ViewProps } from '@superego/app/ui'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { agentName, type ThreadInfo } from '@superego/protocol'
import { useEffect } from 'react'
import { BroomIcon, Button, IconButton, LifebuoyIcon, PlugsConnectedIcon, Select } from '@superego/ui'
import type { MachineEntry } from '@superego/app/ui'
import './styles.css'
import { about, ASK, CLEAR, outsideBlocks } from './shared.ts'

/** Open Ego's thread on a machine: the one given (then remembered), else the one last chosen, else this computer. */
const OPEN = 'ego.open'
const isEgo = (thread: ThreadInfo | undefined) => thread !== undefined && factsOf<true>(thread, about) === true
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
    const chosen = superego.store<string>('machine', 'local', { persist: true })
    // Whether the first-launch page shows, its word on Ego with it: meanwhile the button in the rail breathes.
    const welcoming = superego.store<boolean>('welcoming', false)
    // A button, not a space: it shows a thread, and the sidebar keeps what it shows. First in the rail, its tab ⌘1.
    superego.view('ego.button', {
      title: `Ask ${agentName(superego.app)}`, icon: LifebuoyIcon, context: 'window', fits: ['rail', 'drawer'], default: 'rail', narrow: 'drawer', order: 10, action: OPEN,
      component: (props) => <EgoButton {...props} chosen={chosen.use()} beckon={welcoming.use()} />,
    })
    superego.view('ego.machine', { title: 'Machine', context: 'thread', fits: ['header'], default: 'header', component: MachineSwitch })
    superego.view('ego.clear', { title: 'Clear', icon: BroomIcon, context: 'thread', fits: ['header'], default: 'header', component: ClearButton })
    superego.slot('onboarding', () => <Welcome welcoming={welcoming} />)
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

function EgoButton({ place, chosen, beckon }: ViewProps<'window'> & { chosen: string; beckon: boolean }) {
  const app = useApp()
  const dispatch = useDispatch()
  const machines = useMachines()
  const { thread } = useSelection()
  const keys = useRailShortcut()
  const at = egoMachine(machines, chosen)
  if (!at) return null
  const elsewhere = at !== 'local' && withEgo(machines).length > 1 ? machines.find((m) => m.id === at)?.label : undefined
  const label = `Ask ${agentName(app)}${elsewhere ? ` on ${elsewhere}` : ''}`
  return (
    <RailButton label={label} title={keys ? `${label} (${keys})` : label} on={isEgo(thread)} className={`ego__button ${beckon && place === 'rail' ? 'ego__button--beckon' : ''}`}
      onClick={() => void dispatch(OPEN, {}, { source: place }).catch((error) => console.error(error))}>
      <span className="ego__dot" aria-hidden />
    </RailButton>
  )
}

/** On the first-launch page: what to ask Ego for, where its button is (lit up there meanwhile), and a way in. */
function Welcome({ welcoming }: { welcoming: Store<boolean> }) {
  const app = useApp()
  const dispatch = useDispatch()
  const narrow = useNarrow()
  const shown = withEgo(useMachines()).length > 0
  useEffect(() => {
    if (!shown) return
    welcoming.set(true)
    return () => welcoming.set(false)
  }, [shown, welcoming])
  if (!shown) return null
  const name = agentName(app)
  return (
    <div className="ego__welcome">
      <span className="ego__welcome-mark" aria-hidden><span className="ego__dot" /></span>
      <p>
        Tell <strong>{name}</strong> what you want — a tool, a pane, a board — and it builds it for you.
        {' '}It lives {narrow ? 'at the foot of the side menu' : 'at the top of the rail'}.
      </p>
      <Button onClick={() => void dispatch(OPEN, {}, { source: 'onboarding' }).catch((error) => console.error(error))}>Open {name}</Button>
    </div>
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
    <Chip title="Sent by an outside agent, over MCP" icon={<PlugsConnectedIcon size={13} aria-hidden />}>Outside agent</Chip>
  )
}

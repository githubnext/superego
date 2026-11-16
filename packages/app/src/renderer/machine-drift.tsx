// Whether a machine runs this computer's Superego: said quietly, as a dot with a tooltip, where the machine is shown
// (its row in Settings → Machines, its projects in the sidebar). Also how its Update goes.
import { describeDrift, drifted } from '@superego/protocol'
import { Tooltip } from '@superego/ui'
import type { MachineEntry } from '../shared/bridge.ts'
import { useApp } from './extension.tsx'

/** What to say about a machine's Superego, if anything: its update going on or failed, else how it differs from ours. */
export function driftNote(machine: MachineEntry, name = 'Superego'): { text: string; tone: 'behind' | 'other' | 'updating' | 'failed' } | undefined {
  if (machine.update?.state === 'running') return { text: `Updating ${name} on ${machine.label}…`, tone: 'updating' }
  if (machine.update?.state === 'failed') return { text: `Updating ${machine.label} failed: ${machine.update.error ?? 'see Settings → Machines'}`, tone: 'failed' }
  const text = describeDrift(machine.label, machine.drift, name)
  if (!text || !drifted(machine.drift)) return undefined
  return { text, tone: machine.drift.state === 'behind' || machine.drift.state === 'unknown' ? 'behind' : 'other' }
}

/** A dot saying a machine runs another Superego than this computer's (or is updating), with why in its tooltip. */
export function MachineDrift({ machine, side = 'right' }: { machine: MachineEntry; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const note = driftNote(machine, useApp().name)
  if (!note) return null
  return (
    <Tooltip content={note.text} side={side}>
      <span className={`machine-drift machine-drift--${note.tone}`} role="img" aria-label={note.text} />
    </Tooltip>
  )
}

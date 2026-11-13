// Whether a machine runs this computer's Superego: said quietly, as a dot with a tooltip, where the machine is shown
// (its row in Settings → Machines, its sessions in the sidebar).
import { describeDrift, drifted } from '@superego/protocol'
import { Tooltip } from '@superego/ui'
import type { MachineEntry } from '../shared.ts'
import { useApp } from './extension.tsx'

/** What to say about a machine's Superego, if anything: how it differs from ours. */
export function driftNote(machine: MachineEntry, name = 'Superego'): { text: string; tone: 'behind' | 'other' } | undefined {
  const text = describeDrift(machine.label, machine.drift, name)
  if (!text || !drifted(machine.drift)) return undefined
  return { text, tone: machine.drift.state === 'behind' || machine.drift.state === 'unknown' ? 'behind' : 'other' }
}

/** A dot saying a machine runs another Superego than this computer's, with why in its tooltip. */
export function MachineDrift({ machine, side = 'right' }: { machine: MachineEntry; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const note = driftNote(machine, useApp().name)
  if (!note) return null
  return (
    <Tooltip content={note.text} side={side}>
      <span className={`machine-drift machine-drift--${note.tone}`} role="img" aria-label={note.text} />
    </Tooltip>
  )
}

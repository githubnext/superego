// A machine's colour, a slot of the palette (`--superego-machine-<n>`): its name drawn in it, and the swatches to pick
// another from.
import type { CSSProperties } from 'react'
import { MACHINE_COLOURS } from '@superego/protocol'

/** A slot's colour, as CSS; none without one (a machine from an older Superego's list). */
export const machineColour = (slot: number | undefined) => slot ? `var(--superego-machine-${slot})` : undefined

/** The style that draws in a machine's colour, for what isn't its name (its dot, say). */
export const machineStyle = (slot: number | undefined): CSSProperties | undefined => slot ? { color: machineColour(slot) } : undefined

/** A machine's name, in its colour. */
export function MachineName({ machine, className = '' }: { machine: { label: string; colour?: number | undefined }; className?: string }) {
  return <span className={`superego-machine ${className}`} style={machineStyle(machine.colour)}>{machine.label}</span>
}

/** The palette's swatches, the one chosen ringed; picked, `onPick` with its slot. Arrow keys move along them. */
export function ColourSwatches({ value, onPick, label = 'Colour' }: { value: number | undefined; onPick(slot: number): void; label?: string }) {
  const slots = Array.from({ length: MACHINE_COLOURS }, (_, i) => i + 1)
  return (
    <div className="superego-swatches" role="radiogroup" aria-label={label} onKeyDown={(event) => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
      if (!step) return
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(at + step + buttons.length) % buttons.length]?.focus()
    }}>
      {slots.map((slot) => (
        <button key={slot} type="button" role="radio" aria-checked={slot === value} aria-label={`${label} ${slot}`}
          tabIndex={slot === (value ?? 1) ? 0 : -1} className="superego-swatch" style={{ background: machineColour(slot) }}
          onClick={() => onPick(slot)} />
      ))}
    </div>
  )
}

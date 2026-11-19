import { useState } from 'react'
import { Slider as Base } from '@base-ui/react/slider'

/** Most stops a stepped slider marks on its track; past that they'd crowd into a line. */
const MOST_TICKS = 24

/**
 * A slider (Base UI's): one thumb along a track, dragged, tapped to, or moved with the arrow keys. Stepped, it marks its
 * stops on the track; unstepped, it moves in hundredths of its range. Under a finger its track and thumb are big enough
 * to take one. It follows the drag at once, whatever `value` comes back and when; `onChange` hears each new value.
 */
export function Slider({ value, onChange, min, max, step, label, valueText, disabled, className = '' }: {
  value: number; onChange(value: number): void; min: number; max: number; step?: number | undefined
  /** Its name, for whoever can't see the label beside it. */
  label?: string | undefined
  /** What a value is called, said instead of the number. */
  valueText?(value: number): string
  disabled?: boolean | undefined; className?: string
}) {
  // Shown: the value being dragged to, until `value` changes (the change applied, or another from elsewhere).
  const [shown, setShown] = useState({ value, given: value })
  const at = shown.given === value ? shown.value : value
  if (shown.given !== value) setShown({ value, given: value })
  const stops = step === undefined ? 0 : Math.round((max - min) / step)
  const ticks = stops > 0 && stops <= MOST_TICKS
  return (
    <Base.Root className={`superego-slider ${className}`} value={at} min={min} max={max} step={step ?? (max - min) / 100} disabled={disabled}
      onValueChange={(next) => { if (next === at) return; setShown({ value: next, given: value }); onChange(next) }}>
      <Base.Control className="superego-slider__control">
        <Base.Track className="superego-slider__track">
          <Base.Indicator className="superego-slider__indicator" />
          {ticks && Array.from({ length: stops + 1 }, (_, i) => (
            <span key={i} className="superego-slider__tick" style={{ left: `${(i / stops) * 100}%` }} data-filled={min + i * step! <= at ? '' : undefined} aria-hidden />
          ))}
          <Base.Thumb className="superego-slider__thumb" aria-label={label} getAriaValueText={valueText ? (_, v) => valueText(v) : null} />
        </Base.Track>
      </Base.Control>
    </Base.Root>
  )
}

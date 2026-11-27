import type { ReactNode } from 'react'
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import type { Icon } from './icons.tsx'
import { Tooltip } from './tooltip.tsx'

/** `disabled`: shown, not picked (one that only says what's so, as a Custom that's chosen by changing something else). */
export type SegmentedOption<T extends string> = { value: T; label: string; icon?: Icon; content?: ReactNode; disabled?: boolean }

/**
 * A row of segments, one chosen (Base UI's toggle group): macOS's segmented control. A segment with an icon shows only
 * the icon, its label as its tooltip and its name; arrow keys move between segments.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, label, className = '', side = 'bottom' }: {
  options: SegmentedOption<T>[]; value: T; onChange(value: T): void; label: string; className?: string; side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <ToggleGroup<T> className={`superego-segmented ${className}`} aria-label={label} value={[value]}
      // Pressing the chosen one again leaves it chosen.
      onValueChange={(next) => { const chosen = next[0]; if (chosen !== undefined && chosen !== value) onChange(chosen) }}>
      {options.map((option) => {
        const Glyph = option.icon
        const segment = (
          <Toggle<T> key={option.value} value={option.value} disabled={option.disabled ?? false} className="superego-segmented__item" aria-label={option.label}>
            {Glyph ? <Glyph size={15} aria-hidden /> : option.content ?? option.label}
          </Toggle>
        )
        return Glyph ? <Tooltip key={option.value} content={option.label} side={side}>{segment}</Tooltip> : segment
      })}
    </ToggleGroup>
  )
}

import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextField({ className = '', ...props }, ref) {
    return <input ref={ref} className={`superego-field ${className}`} {...props} />
  },
)

export type SelectOption = { value: string; label: string; group?: string }

const PLACEHOLDER = '\u0000placeholder'

/** A native select; with `placeholder` it shows that text (e.g. "Mixed") until something is chosen. */
export function Select({ options, value, onChange, nullLabel, placeholder, className = '', ...props }:
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'placeholder'> & {
    options: SelectOption[]; value: string | null; onChange(value: string | null): void; nullLabel?: string; placeholder?: string
  }) {
  const groups = new Map<string | undefined, SelectOption[]>()
  for (const option of options) groups.set(option.group, [...groups.get(option.group) ?? [], option])
  const render = (list: SelectOption[]) => list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
  return (
    <select className={`superego-field superego-select ${className}`} value={placeholder !== undefined ? PLACEHOLDER : value ?? ''}
      onChange={(e) => { if (e.target.value !== PLACEHOLDER) onChange(e.target.value === '' ? null : e.target.value) }} {...props}>
      {placeholder !== undefined && <option value={PLACEHOLDER} disabled hidden>{placeholder}</option>}
      {nullLabel !== undefined && <option value="">{nullLabel}</option>}
      {[...groups].map(([group, list]) => group === undefined ? render(list) : <optgroup key={group} label={group}>{render(list)}</optgroup>)}
    </select>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(checked: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`superego-switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="superego-switch__thumb" />
    </button>
  )
}

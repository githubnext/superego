import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextField({ className = '', ...props }, ref) {
    return <input ref={ref} className={`mu-field ${className}`} {...props} />
  },
)

export type SelectOption = { value: string; label: string; group?: string }

/** A native select; options with a `group` are gathered under it, in first-seen order. */
export function Select({ options, value, onChange, nullLabel, className = '', ...props }:
  Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> & {
    options: SelectOption[]; value: string | null; onChange(value: string | null): void; nullLabel?: string
  }) {
  const groups = new Map<string | undefined, SelectOption[]>()
  for (const option of options) groups.set(option.group, [...groups.get(option.group) ?? [], option])
  const render = (list: SelectOption[]) => list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)
  return (
    <select className={`mu-field mu-select ${className}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} {...props}>
      {nullLabel !== undefined && <option value="">{nullLabel}</option>}
      {[...groups].map(([group, list]) => group === undefined ? render(list) : <optgroup key={group} label={group}>{render(list)}</optgroup>)}
    </select>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(checked: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`mu-switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="mu-switch__thumb" />
    </button>
  )
}

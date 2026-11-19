// Settings' controls: one setting's row, drawn by its type, and the controls only Settings uses (a stepped slider, a
// colour field, the layout's buttons).
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Json, SettingInfo } from '@superego/protocol'
import { Button, FontPicker, Select, Slider, Switch, TextField } from '@superego/ui'
import { fonts } from '../fonts.ts'
import { Keymap } from '../Keymap.tsx'
import { useRegistry } from '../registry.tsx'
import { useSettingsDialog } from '../state.tsx'

/** The layout's row: to its text, and back to the defaults. Always here, whatever the layout hides. */
function LayoutControl() {
  const dispatch = useRegistry().router.dispatch
  const { close } = useSettingsDialog()
  const run = (id: string) => void dispatch(id, {}, { source: 'settings' }).catch((error) => console.error(error))
  return (
    <span className="setting__buttons">
      <Button onClick={() => { close(); run('layout.edit') }}>Edit layout…</Button>
      <Button onClick={() => run('layout.reset')}>Reset</Button>
    </span>
  )
}

/** One setting's row. `apply` changes it wherever it lives; `mixed` shows that the machines it spans disagree. */
export function Setting({ setting, value, apply, mixed, note }: {
  setting: SettingInfo; value: Json; apply(value: Json): Promise<unknown>; mixed?: boolean; note?: string
}) {
  const [error, setError] = useState<string>()
  const knownFonts = useSyncExternalStore(fonts.subscribe, fonts.get)
  const set = (next: Json) => {
    setError(undefined)
    apply(next).catch((e: Error) => setError(e.message))
  }
  if (mixed) value = null
  const disabled = Boolean(setting.disabled)
  let control
  switch (setting.type) {
    case 'boolean': control = <Switch label={setting.title} checked={!mixed && value === true} disabled={disabled} onChange={set} />; break
    case 'choice': control = setting.slider
      ? <StepSlider label={setting.title} options={setting.options} value={typeof value === 'string' ? value : null} disabled={disabled} onChange={set} />
      : <Select aria-label={setting.title} options={setting.options} value={typeof value === 'string' ? value : null} disabled={disabled}
      placeholder={mixed ? 'Mixed' : undefined} nullLabel={setting.nullable ? setting.nullLabel ?? 'Default' : undefined} onChange={set} />; break
    case 'number': control = <TextField type="number" aria-label={setting.title} defaultValue={String(value ?? '')} min={setting.min} max={setting.max} step={setting.step}
      disabled={disabled} onBlur={(e) => set(Number(e.target.value))} />; break
    case 'font': control = <FontPicker label={setting.title} value={typeof value === 'string' ? value : null} monospace={setting.monospace}
      nullLabel={setting.nullLabel} fonts={knownFonts} loadFonts={fonts.load} onChange={set} />; break
    case 'color': control = <ColorField label={setting.title} value={typeof value === 'string' ? value : String(setting.default ?? '')} fallback={String(setting.default ?? '')} disabled={disabled} onChange={set} onInvalid={setError} />; break
    case 'keymap': return <Keymap setting={setting} value={value} apply={apply} />
    case 'layout': control = <LayoutControl />; break
    // Pinned and unpinned from the threads themselves, never in Settings.
    case 'pins': return null
    case 'string': control = <TextField type={setting.secret ? 'password' : 'text'} aria-label={setting.title} defaultValue={typeof value === 'string' ? value : ''}
      placeholder={setting.placeholder} disabled={disabled} onBlur={(e) => set(e.target.value)} />; break
  }
  return (
    <div className="setting" data-key={setting.key}>
      <div className="setting__label">
        <div>{setting.title}</div>
        {(setting.description || setting.disabled) && <div className="settings__note">{setting.disabled ?? setting.description}</div>}
        {(mixed || note) && <div className="settings__note">{[mixed && 'Mixed: the machines differ.', note].filter(Boolean).join(' ')}</div>}
        {error && <div className="setting__error">{error}</div>}
      </div>
      <div className="setting__control">{control}</div>
    </div>
  )
}

/** A choice along a scale: a slider that stops at each option, named under its stops. */
function StepSlider({ label, options, value, disabled, onChange }: {
  label: string; options: { value: string; label: string }[]; value: string | null; disabled: boolean; onChange(value: string): void
}) {
  const at = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <span className="step-slider">
      <Slider label={label} valueText={(i) => options[i]?.label ?? ''} min={0} max={options.length - 1} step={1} value={at} disabled={disabled}
        onChange={(i) => onChange(options[i]!.value)} />
      <span className="step-slider__stops" aria-hidden>
        {options.map((option, index) => <span key={option.value} className={index === at ? 'is-current' : ''}>{option.label}</span>)}
      </span>
    </span>
  )
}

/** A colour as sRGB hex, for the system picker (which knows no other): drawn and read back, so any CSS colour works. */
function hexOf(color: string) {
  const context = document.createElement('canvas').getContext('2d')
  if (!context || !CSS.supports('color', color)) return '#000000'
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`
}

/**
 * A colour: its swatch (click it for the system picker) and the CSS it is, to type any colour the browser reads
 * (display-p3, oklch, a name); back to the default when it isn't that.
 */
function ColorField({ label, value, fallback, disabled, onChange, onInvalid }: {
  label: string; value: string; fallback: string; disabled?: boolean; onChange(value: string): void; onInvalid(message: string): void
}) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === value) return
    if (!CSS.supports('color', trimmed)) { onInvalid(`“${trimmed}” isn't a colour`); setText(value); return }
    onChange(trimmed)
  }
  return (
    <span className="color-field">
      <label className="color-field__swatch" style={{ background: value }} title="Pick a colour">
        <input type="color" aria-label={`${label}: pick`} value={hexOf(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </label>
      <TextField aria-label={label} value={text} disabled={disabled} spellCheck={false} onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value) }} />
      {value !== fallback && <Button onClick={() => onChange(fallback)} disabled={disabled}>Reset</Button>}
    </span>
  )
}


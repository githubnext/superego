// Settings' controls: one setting's row, drawn by its type, and the controls only Settings uses (a stepped slider, a
// colour field, the layout's buttons).
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Json, SettingInfo } from '@superego/protocol'
import { Button, FontPicker, Select, Slider, Switch, TextField } from '@superego/ui'
import { fonts } from '../fonts.ts'
import { Keymap } from '../Keymap.tsx'
import { useRegistry } from '../registry.tsx'
import { useSettingsDialog } from '../state.tsx'
import { ThemePicker } from '../themes.tsx'

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

/**
 * One setting's row. `apply` changes it wherever it lives; `mixed` shows that the machines it spans disagree. A colour
 * left at its default may be drawn as another (`inUse`: the theme's accent), which it shows instead.
 */
export function Setting({ setting, value, apply, mixed, note, inUse }: {
  setting: SettingInfo; value: Json; apply(value: Json): Promise<unknown>; mixed?: boolean; note?: string; inUse?: string | undefined
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
    case 'color': control = <ColorField label={setting.title} value={typeof value === 'string' ? value : String(setting.default ?? '')} fallback={String(setting.default ?? '')} inUse={inUse} disabled={disabled} onChange={set} onInvalid={setError} />; break
    case 'theme': control = <ThemePicker label={setting.title} appearance={setting.appearance} value={value} disabled={disabled} onChange={set} />; break
    case 'keymap': return <Keymap setting={setting} value={value} apply={apply} />
    case 'layout': control = <LayoutControl />; break
    // Pinned and unpinned from the threads themselves, never in Settings.
    case 'pins': return null
    // The Model section's own list draws them (settings/models.tsx).
    case 'models': return null
    case 'string': control = <TextField type="text" aria-label={setting.title} defaultValue={typeof value === 'string' ? value : ''}
      placeholder={setting.placeholder} disabled={disabled} onBlur={(e) => set(e.target.value)} />; break
    case 'secret': control = <SecretField label={setting.title} isSet={value === true} placeholder={setting.placeholder} disabled={disabled} apply={(next) => { setError(undefined); return apply(next).catch((e: Error) => { setError(e.message); throw e }) }} />; break
  }
  return (
    <div className="setting" data-key={setting.key}>
      <div className="setting__label">
        <div>{setting.title}</div>
        {(setting.description || setting.disabled) && <div className="settings__note">{setting.disabled ?? setting.description}</div>}
        {(mixed || note || setting.note) && <div className="settings__note">{[mixed && 'Mixed: the machines differ.', note, setting.note].filter(Boolean).join(' ')}</div>}
        {setting.problem && <div className="setting__error">{setting.problem}</div>}
        {error && <div className="setting__error">{error}</div>}
      </div>
      <div className="setting__control">{control}</div>
    </div>
  )
}

/**
 * A secret (`apply`: its value, or null to clear it): the window never has it back, so set, it shows as Set with Replace
 * and Clear; replacing, or not set, a masked field saved with Enter or Save (Escape leaves it as it was).
 */
function SecretField({ label, isSet, placeholder, disabled, apply }: {
  label: string; isSet: boolean; placeholder?: string; disabled: boolean; apply(value: string | null): Promise<unknown>
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const run = (value: string | null) => {
    setBusy(true)
    // A failure shows as the setting's error (apply); the field stays open to try again.
    apply(value).then(() => { setText(''); setEditing(false) }, () => {}).finally(() => setBusy(false))
  }
  if (isSet && !editing) {
    return (
      <span className="setting__buttons">
        <span className="settings__note">Set</span>
        <Button onClick={() => setEditing(true)} disabled={disabled || busy}>Replace</Button>
        <Button onClick={() => run(null)} disabled={disabled || busy}>Clear</Button>
      </span>
    )
  }
  // Trimmed where it's kept (the settings registry): here, only whether there's anything to save.
  const save = () => { if (text.trim()) run(text) }
  return (
    <span className="setting__buttons setting__secret">
      <TextField type="password" aria-label={label} value={text} placeholder={placeholder} disabled={disabled || busy} autoComplete="off" spellCheck={false}
        autoFocus={editing} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          // Taken here: Settings, as a phone's dialog, would close on it too.
          if (e.key === 'Escape' && editing) { e.preventDefault(); e.stopPropagation(); setText(''); setEditing(false) }
        }} />
      <Button onClick={save} disabled={disabled || busy || !text.trim()}>Save</Button>
      {editing && <Button onClick={() => { setText(''); setEditing(false) }} disabled={busy}>Cancel</Button>}
    </span>
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

/** A colour as the page draws it now: `light-dark()` taken for the window's appearance, which a canvas can't. */
function resolved(color: string) {
  if (!color.includes('light-dark(')) return color
  const probe = document.body.appendChild(document.createElement('span'))
  probe.style.color = color
  const drawn = getComputedStyle(probe).color
  probe.remove()
  return drawn
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
 * (display-p3, oklch, a name); back to the default when it isn't that. Left at the default while another colour is
 * drawn in its place (`inUse`, a theme's), the swatch is that one and the field empty, for one of your own.
 */
function ColorField({ label, value, fallback, inUse, disabled, onChange, onInvalid }: {
  label: string; value: string; fallback: string; inUse?: string | undefined; disabled?: boolean; onChange(value: string): void; onInvalid(message: string): void
}) {
  const standIn = value === fallback ? inUse : undefined
  const shown = standIn ?? value
  const [text, setText] = useState(standIn ? '' : value)
  useEffect(() => { setText(standIn ? '' : value) }, [value, standIn])
  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed === value || (standIn && !trimmed)) return
    if (!CSS.supports('color', trimmed)) { onInvalid(`“${trimmed}” isn't a colour`); setText(value); return }
    onChange(trimmed)
  }
  return (
    <span className="color-field">
      <label className="color-field__swatch" style={{ background: shown }} title="Pick a colour">
        <input type="color" aria-label={`${label}: pick`} value={hexOf(resolved(shown))} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </label>
      <TextField aria-label={label} value={text} placeholder={standIn ? 'The theme’s' : undefined} disabled={disabled} spellCheck={false} onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value) }} />
      {value !== fallback && <Button onClick={() => onChange(fallback)} disabled={disabled}>Reset</Button>}
    </span>
  )
}


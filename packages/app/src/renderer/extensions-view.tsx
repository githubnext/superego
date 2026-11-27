// A machine's extensions, drawn: the preset cards of first-run setup (Core and Full, Custom once something's changed),
// Settings → Extensions (the section's own component: "Start from" over the switches, each changed one marked), and the
// switches both share, grouped by what each extension is for.
import { useState, type ReactNode } from 'react'
import { inPreset, type ExtensionPreset, type Json, type SectionInfo } from '@superego/protocol'
import { CheckIcon, SegmentedControl, Switch } from '@superego/ui'
import { useSettings } from './client.ts'
import { changes, customLine, extensionsOf, grouped, picked, PRESET_TITLES, presetLine, type ExtensionRow, type Extensions, type Picked } from './extension-presets.ts'
import { useRegistry } from './registry.tsx'
import mikkel2x from './assets/mikkel@2x.png?url'
import mikkel3x from './assets/mikkel@3x.png?url'
import './extensions.css'

/** Whose choice Full is, and where to read about him. */
const PICKED_BY = { name: 'Mikkel', url: 'https://githubnext.com/people/mikker/' }

/** Change a machine's extensions: pick a preset (its changes undone) or flip a switch. Failures are said by the caller. */
function useChange(machine: string, source: string) {
  const dispatch = useRegistry().router.dispatch
  return {
    pick: (preset: ExtensionPreset) => dispatch('extensions.preset', { preset }, { machine, source }),
    turn: (row: ExtensionRow, on: boolean) => dispatch('settings.set', { key: `extensions.${row.name}`, value: on as Json }, { machine, source }),
  }
}

/** Run a change, its failure logged and kept to say. */
function useFailure(): [string | undefined, (what: string, change: () => Promise<unknown>) => void] {
  const [error, setError] = useState<string>()
  return [error, (what, change) => {
    setError(undefined)
    change().catch((failed: Error) => {
      console.error(`${what} failed`, failed)
      setError(failed.message)
    })
  }]
}

/**
 * The switches, under their groups' headings: each with its name (and its id, `ids`, for profile authors), a line on
 * what it does, and an experimental one tagged. `mark`: a switch that differs from the preset is filled.
 */
export function ExtensionSwitches({ rows, onTurn, ids = false, mark = false }: { rows: ExtensionRow[]; onTurn(row: ExtensionRow, on: boolean): void; ids?: boolean; mark?: boolean }) {
  const changed = new Set(mark ? changes(rows).map((row) => row.name) : [])
  return (
    <div className="extensions">
      {grouped(rows).map((group) => (
        <section key={group.id} className="extensions__group" aria-label={group.title}>
          <h3>{group.title}</h3>
          <ul>
            {group.rows.map((row) => (
              <li key={row.name} className={`extensions__row ${changed.has(row.name) ? 'is-changed' : ''}`} data-extension={row.name}>
                <div className="extensions__what">
                  <div>
                    <span className="extensions__title">{row.title}</span>
                    {row.experimental && <span className="extensions__tag">Experimental</span>}
                    {ids && <code>{row.name}</code>}
                  </div>
                  {row.description && <div className="extensions__detail" title={row.description}>{row.description}</div>}
                </div>
                <Switch label={row.title} checked={row.on} onChange={(on) => onTurn(row, on)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** A row of dots, one for each non-experimental extension, Core's first: filled for those `on` turns on. */
function Dots({ rows, on }: { rows: ExtensionRow[]; on(row: ExtensionRow): boolean }) {
  const ordered = rows.filter((row) => !row.experimental).sort((a, b) => Number(Boolean(b.core)) - Number(Boolean(a.core)))
  return <span className="presets__dots" aria-hidden>{ordered.map((row) => <i key={row.name} className={on(row) ? 'is-on' : ''} />)}</span>
}

/** One way to start: a card, picked by a click anywhere on it. */
function PresetCard({ title, line, checked, onPick, by, dots }: { title: string; line: string; checked: boolean; onPick(): void; by?: ReactNode; dots: ReactNode }) {
  return (
    <div className={`presets__card ${checked ? 'is-on' : ''}`} onClick={onPick}>
      <button type="button" role="radio" aria-checked={checked} className="presets__pick">
        <span className="presets__title">{title}</span>
        <span className="presets__line">{line}</span>
      </button>
      {by}
      <span className="presets__check" aria-hidden>{checked && <CheckIcon size={11} weight="bold" />}</span>
      {dots}
    </div>
  )
}

/**
 * Setup's extensions: Core or Full as two cards (Custom a third once a switch differs, saying how), every switch under
 * them while `open`, and a word that Settings has them too.
 */
export function SetupExtensions({ machine, extensions, open, onOpen }: { machine: string; extensions: Extensions; open: boolean; onOpen(open: boolean): void }) {
  const [error, run] = useFailure()
  const change = useChange(machine, 'setup')
  const now = picked(extensions)
  const { rows } = extensions
  const pick = (preset: ExtensionPreset) => { if (now !== preset) run('Picking extensions', () => change.pick(preset)) }
  const by = (
    <span className="presets__by">
      <img src={mikkel2x} srcSet={`${mikkel2x} 2x, ${mikkel3x} 3x`} alt="" width={14} height={14} />
      <span>Picked by <a href={PICKED_BY.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{PICKED_BY.name}</a></span>
    </span>
  )
  return (
    <section className="setup__extensions" aria-label="Extensions">
      <h2>Extensions</h2>
      <div className="presets__cards" role="radiogroup" aria-label="Extensions to start with" data-count={now === 'custom' ? 3 : 2}>
        <PresetCard title="Core" line={presetLine('core', rows)} checked={now === 'core'} onPick={() => pick('core')} dots={<Dots rows={rows} on={(row) => inPreset(row, 'core')} />} />
        <PresetCard title="Full" line={presetLine('full', rows)} checked={now === 'full'} onPick={() => pick('full')} by={by} dots={<Dots rows={rows} on={(row) => inPreset(row, 'full')} />} />
        {now === 'custom' && <PresetCard title="Custom" line={customLine(extensions)} checked onPick={() => {}} dots={<Dots rows={rows} on={(row) => row.on} />} />}
      </div>
      <p><button type="button" className="setup__link" aria-expanded={open} onClick={() => onOpen(!open)}>{open ? 'Hide the list' : `Show all ${rows.length}`}</button></p>
      {open && <ExtensionSwitches rows={rows} onTurn={(row, on) => run(`Turning ${row.title} ${on ? 'on' : 'off'}`, () => change.turn(row, on))} />}
      {error && <p className="setup__error" role="alert">{error}</p>}
      <p className="setup__note">Change them any time in Settings.</p>
    </section>
  )
}

const SEGMENTS: { value: Picked; label: string }[] = [{ value: 'core', label: 'Core' }, { value: 'full', label: 'Full' }, { value: 'custom', label: 'Custom' }]

/**
 * Settings → a machine → Extensions: what it starts from (Core, Full, or Custom while a switch differs), what that turns
 * on, and the switches with their ids, each that differs from the preset marked.
 */
export function ExtensionsSettings({ target }: { target: string; section: SectionInfo }) {
  const snapshot = useSettings(target, true)
  const extensions = extensionsOf(snapshot)
  const [error, run] = useFailure()
  const change = useChange(target, 'settings')
  if (!extensions) return null
  const now = picked(extensions)
  const line = now === 'custom' ? `${customLine(extensions)}. Pick ${PRESET_TITLES.core} or ${PRESET_TITLES.full} to start over.` : presetLine(now, extensions.rows)
  return (
    <>
      <div className="setting extensions__start">
        <div className="setting__label">
          <div>Start from</div>
          <div className="settings__note">{line}</div>
          {error && <div className="setting__error">{error}</div>}
        </div>
        <div className="setting__control">
          <SegmentedControl label="Start from" value={now} options={SEGMENTS.map((s) => ({ ...s, disabled: s.value === 'custom' && now !== 'custom' }))}
            onChange={(preset) => { if (preset !== 'custom') run('Picking extensions', () => change.pick(preset)) }} />
        </div>
      </div>
      <ExtensionSwitches rows={extensions.rows} ids mark onTurn={(row, on) => run(`Turning ${row.title} ${on ? 'on' : 'off'}`, () => change.turn(row, on))} />
    </>
  )
}

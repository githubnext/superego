// Settings, drawn generically from what each endpoint registers: the app's own settings and every machine's. Sections
// may name a custom component (`ui`) drawn below their settings; the Providers section is one.
import { useEffect } from 'react'
import type { Json, SectionInfo, SettingsSnapshot } from '@superego/protocol'
import { Dialog, Glyph } from '@superego/ui'
import { APP } from '../shared/app-settings.ts'
import type { MachineEntry } from '../shared/bridge.ts'
import { useSettings, useValue } from './client.ts'
import { Contained } from './contained.tsx'
import { useRegistry } from './registry.tsx'
import { settingsEntry } from './lookups.ts'
import { useLocalState } from './local-state.ts'
import { Setting } from './settings/controls.tsx'
import { AllMachines, machineGlyph, Machines } from './settings/machines.tsx'

/** Settings → Machines (also opened by Update: see actions.tsx). */
const MACHINES = '$machines'
const ALL = '$all'

/** Settings: wide, a pane beside the rail (Escape goes back); on a phone, a dialog. */
export function SettingsView({ machines, onClose, pane = false }: { machines: MachineEntry[]; onClose(): void; pane?: boolean }) {
  const [kept, setTarget] = useLocalState('settings.target', APP)
  // The section kept from last time, unless its machine has gone since.
  const target = kept === APP || kept === MACHINES || kept === ALL || machines.some((m) => m.id === kept) ? kept : APP
  const machine = machines.find((m) => m.id === target)
  const connected = target === APP || machine?.state === 'connected'
  const snapshot = useSettings(target, target !== MACHINES && target !== ALL && connected)
  const editable = machines.filter((m) => m.state === 'connected')
  useEffect(() => {
    if (!pane) return
    // Escape that something in it took (a picker closing, a field) stays there.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane, onClose])

  const body = (
      <div className="settings__body">
        <nav className="settings__nav">
          <button className={target === APP ? 'is-selected' : ''} onClick={() => setTarget(APP)}>General</button>
          <button className={target === MACHINES ? 'is-selected' : ''} onClick={() => setTarget(MACHINES)}>Machines</button>
          {editable.length > 1 && <button className={target === ALL ? 'is-selected' : ''} onClick={() => setTarget(ALL)}>All machines</button>}
          {machines.filter((m) => m.state !== 'disabled').map((m) => (
            <button key={m.id} className={`settings__nav-machine ${target === m.id ? 'is-selected' : ''}`} onClick={() => setTarget(m.id)}>
              <Glyph shape={machineGlyph(m.state)} /> {m.label}
            </button>
          ))}
        </nav>
        <div className="settings__content">
          {target === MACHINES ? <Machines machines={machines} onOpen={setTarget} />
            : target === ALL ? <AllMachines machines={editable} />
            : !connected ? <p className="settings__note">{machine?.label} is {machine?.state}. Its settings live on it, so they show once it is back.</p>
            : !snapshot ? <p className="settings__note">Loading…</p>
            : snapshot.sections.filter((section) => section.ui || section.settings.some((s) => !s.hidden)).map((section) => <Section key={section.id} machine={machine} target={target} section={section} values={snapshot.values} />)}
        </div>
      </div>
  )
  return pane
    ? <section className="settings settings--pane" aria-label="Settings">{body}</section>
    : <Dialog title="Settings" size="large" onClose={onClose} className="settings">{body}</Dialog>
}

function Section({ machine, target, section, values }: { machine: MachineEntry | undefined; target: string; section: SectionInfo; values: SettingsSnapshot['values'] }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const custom = section.ui ? settingsEntry(registry, section.ui, target) : undefined
  const Custom = custom?.component
  // Drawn from a live value: that's its data, kept current.
  const live = useValue<Json>(section.value ? machine : undefined, section.value ?? '')
  return (
    <section className="settings-section">
      <h2>{section.title}</h2>
      {section.description && <p className="settings__note">{section.description}</p>}
      {section.settings.filter((s) => !s.hidden).map((setting) => (
        <Setting key={setting.key} setting={setting} value={values[setting.key] ?? null}
          apply={(value) => dispatch(target === APP ? 'app.settings.set' : 'settings.set', { key: setting.key, value }, { machine: target, source: 'settings' })} />
      ))}
      {Custom && <Contained name={section.ui!} scope={custom!.owner.profile}><Custom target={target} section={section.value ? { ...section, ...(live != null ? { data: live } : {}) } : section} /></Contained>}
    </section>
  )
}

// The first-launch page, in the main column: what extensions say of themselves here (the `onboarding` slot: Ego's word
// on asking it for things), the bundled extensions this computer offers, each with its switch (the very switches of
// Settings → Extensions, `extensions.<name>`, changed the same way), and Get started, kept in view, after which it shows no more on
// this machine (ONBOARDED). It shows while no thread is selected on a fresh data folder, and again when asked (Show
// onboarding, in ⌘K) until a thread is picked or Get started.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ONBOARDED, type Json, type SettingInfo } from '@superego/protocol'
import { Button, Switch } from '@superego/ui'
import { useSettings } from './client.ts'
import { Slot, useApp, useRegistry } from './extension.tsx'
import { firstWindow } from './local-state.ts'
import { useMachines, useSelection, useSettingsDialog } from './state.tsx'
import './onboarding.css'

/** Its machine: this computer, whose extensions these are and which keeps that it was seen. */
const LOCAL = 'local'
const PREFIX = 'extensions.'

let asked = false
const listeners = new Set<() => void>()
const ask = (value: boolean) => { if (asked === value) return; asked = value; for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Show the page again (with nothing selected, where it shows), until a thread is picked or Get started. */
export function showOnboarding() { ask(true) }

/** This computer's settings, while it's connected. */
function useLocalSettings() {
  const local = useMachines().find((m) => m.id === LOCAL)
  return useSettings(LOCAL, local?.state === 'connected')
}

/** Whether the page shows now, in place of "Select or start a thread". */
export function useOnboarding(): boolean {
  const snapshot = useLocalSettings()
  const wanted = useSyncExternalStore(subscribe, () => asked)
  const { selection } = useSelection()
  const settings = useSettingsDialog()
  // Picking a thread puts it away; asked for, it comes out from behind Settings.
  useEffect(() => { if (selection) ask(false) }, [selection])
  useEffect(() => { if (wanted) settings.close() }, [wanted])
  // On its own, in the app's first window only: another opened beside it starts on the threads.
  return !selection && (wanted || (firstWindow && snapshot?.values[ONBOARDED] === false))
}

export function Onboarding() {
  const app = useApp()
  const dispatch = useRegistry().router.dispatch
  const snapshot = useLocalSettings()
  const [error, setError] = useState<string>()
  const switches = snapshot?.sections.find((s) => s.id === 'extensions')?.settings.filter((s) => !s.hidden && s.key.startsWith(PREFIX)) ?? []
  const on = (setting: SettingInfo) => snapshot?.values[setting.key] === true
  const set = (key: string, value: Json) => dispatch('settings.set', { key, value }, { machine: LOCAL, source: 'onboarding' })
  const change = (settings: SettingInfo[], value: boolean) => {
    setError(undefined)
    Promise.all(settings.filter((s) => on(s) !== value).map((s) => set(s.key, value))).catch((e: Error) => setError(e.message))
  }
  const start = () => {
    ask(false)
    set(ONBOARDED, true).catch((e: Error) => setError(e.message))
  }
  return (
    <div className="onboarding">
      <h1>Welcome to {app.name}</h1>
      <Slot name="onboarding" props={{}} />
      {switches.length > 0 && (
        <section className="onboarding__extensions" aria-label="Extensions">
          <div className="onboarding__head">
            <h2>Extensions</h2>
            <Button variant="ghost" disabled={switches.every(on)} onClick={() => change(switches, true)}>Enable all</Button>
            <Button variant="ghost" disabled={!switches.some(on)} onClick={() => change(switches, false)}>Disable all</Button>
          </div>
          <ul>
            {switches.map((setting) => (
              <li key={setting.key} className="onboarding__extension" data-extension={setting.key.slice(PREFIX.length)}>
                <div className="onboarding__about">
                  <div><span className="onboarding__title">{setting.title}</span> <code>{setting.key.slice(PREFIX.length)}</code></div>
                  {setting.description && <div className="onboarding__description" title={setting.description}>{setting.description}</div>}
                </div>
                <Switch label={setting.title} checked={on(setting)} onChange={(value) => change([setting], value)} />
              </li>
            ))}
          </ul>
          <p className="onboarding__note">Change them any time in Settings.</p>
        </section>
      )}
      <div className="onboarding__foot">
        {error && <p className="onboarding__error">{error}</p>}
        <Button variant="primary" onClick={start}>Get started</Button>
      </div>
    </div>
  )
}

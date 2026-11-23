// Settings → Hotkeys: every action that runs without asking for more, with its shortcut. Click one and press keys to
// change it; ⌫ removes it, Esc keeps it. What differs from the actions' own is all that is stored (`app.keys`).
import { useState, type KeyboardEvent } from 'react'
import type { ActionInfo, Json, SettingInfo } from '@superego/protocol'
import { Button, IconButton } from '@superego/ui'
import { runsBare } from './actions.tsx'
import { bound, conflicts, keyLabel, normalize, safe, shortcutOf, useActions, type Keymap as KeymapValue } from './keys.ts'
import { useSelection } from './state.tsx'

export function Keymap({ setting, value, apply }: { setting: SettingInfo; value: Json; apply(value: Json): Promise<unknown> }) {
  const { selection } = useSelection()
  const keymap = (value ?? {}) as KeymapValue
  const actions = useActions(selection?.machine ?? 'local')
    .filter((a) => a.expose.includes('ui') && runsBare(a))
    .sort((a, b) => a.id.localeCompare(b.id))
  const clashes = conflicts(actions, keymap)
  const [error, setError] = useState<string>()
  const titles = new Map(actions.map((a) => [a.id, a.title]))

  const change = (action: ActionInfo, keys: string | null | undefined) => {
    const next = { ...keymap }
    // Back to its own: forget the override.
    if (keys === undefined || (keys ?? null) === (action.keys ? normalize(action.keys) : null)) delete next[action.id]
    else next[action.id] = keys
    setError(undefined)
    apply(next).catch((e: Error) => setError(e.message))
  }

  const groups = new Map<string, ActionInfo[]>()
  for (const action of actions) {
    const group = action.id.split('.')[0]!
    groups.set(group, [...groups.get(group) ?? [], action])
  }
  return (
    <div className="keymap" data-key={setting.key}>
      <div className="keymap__head">
        <div className="settings__note">{setting.description}</div>
        {Object.keys(keymap).length > 0 && <Button onClick={() => { setError(undefined); apply({}).catch((e: Error) => setError(e.message)) }}>Reset all</Button>}
      </div>
      {error && <div className="setting__error">{error}</div>}
      {[...groups].map(([group, list]) => (
        <div key={group} className="keymap__group">
          <h3>{group}</h3>
          {list.map((action) => {
            const keys = bound(action, keymap)
            const others = keys ? (clashes.get(keys) ?? []).filter((id) => id !== action.id) : []
            return (
              <div key={action.id} className="keymap__row" data-action={action.id}>
                <div className="keymap__label">
                  <span>{action.title}</span>
                  {others.length > 0 && <span className="keymap__clash">Also {others.map((id) => titles.get(id) ?? id).join(', ')}</span>}
                </div>
                <Recorder keys={keys} clash={others.length > 0} onChange={(next) => change(action, next)} />
                {action.id in keymap
                  ? <IconButton className="keymap__reset" label={action.keys ? `Back to ${keyLabel(action.keys)}` : 'Back to none'} onClick={() => change(action, undefined)}>↺</IconButton>
                  : <span className="keymap__reset" />}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** A shortcut you click and then press. */
function Recorder({ keys, clash, onChange }: { keys: string | undefined; clash: boolean; onChange(keys: string | null): void }) {
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState<string>()
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    // Nothing else hears the keys while recording, the shell's shortcuts included.
    event.preventDefault()
    event.stopPropagation()
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (plain && event.key === 'Escape') return stop()
    if (plain && (event.key === 'Backspace' || event.key === 'Delete')) { stop(); return onChange(null) }
    const pressed = shortcutOf(event.nativeEvent)
    if (!pressed) return
    if (!safe(pressed)) return setHint('Add ⌘, ⌃ or ⌥, so typing stays typing')
    stop()
    onChange(pressed)
  }
  const stop = () => { setRecording(false); setHint(undefined) }
  return (
    <button
      className={`keymap__keys ${recording ? 'is-recording' : ''} ${clash ? 'is-clash' : ''}`}
      aria-label={recording ? 'Press a shortcut' : keys ? `Shortcut ${keyLabel(keys)}; click to change` : 'No shortcut; click to add'}
      onClick={() => setRecording(true)} onBlur={stop} onKeyDown={onKeyDown}>
      {recording ? hint ?? 'Press keys…' : keys ? <kbd>{keyLabel(keys)}</kbd> : <span className="keymap__none">—</span>}
    </button>
  )
}

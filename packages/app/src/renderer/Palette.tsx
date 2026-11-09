// The command palette (⌘K): commands only, filtered as you type; going somewhere is the navigator's (⌘L). Arrow keys
// move, Enter runs, Escape closes. Every action that runs without more input is in it, with its shortcut.
import { useMemo, useState, type KeyboardEvent } from 'react'
import { Dialog, StatusGlyph } from '@mu/ui'
import type { Status } from '@mu/protocol'
import { score } from './score.ts'
import { useRegistry } from './extension.tsx'
import { useSelection } from './state.tsx'
import { runsBare } from './actions.tsx'
import { bound, keyLabel, useActions, useKeymap } from './keys.ts'

type Item = { id: string; title: string; detail?: string; status?: Status; keys?: string; run(): void }


export function Palette({ onClose }: { onClose(): void }) {
  const registry = useRegistry()
  const { selection } = useSelection()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const actions = useActions(selection?.machine)
  const [keymap] = useKeymap()

  const items = useMemo<Item[]>(() => {
    const done = (run: () => void) => () => { onClose(); run() }
    // Every action that can run as it is: the palette dispatches it like a key would.
    // The app's and the selected machine's too: thread actions apply to the selected thread.
    const all: Item[] = actions.filter((a) => a.expose.includes('ui') && runsBare(a) && a.id !== 'app.palette' && (!a.thread || selection)).map((a): Item => ({
      id: a.id, title: a.title, ...(bound(a, keymap) ? { keys: bound(a, keymap) } : {}), ...(a.thread && selection ? { detail: 'this thread' } : {}),
      run: done(() => void registry.router.dispatch(a.id, {}, { source: 'palette' }).catch((error) => console.error(error))),
    }))
    return all.map((item) => ({ item, rank: score(item.title, query) }))
      .filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank).map(({ item }) => item).slice(0, 50)
  }, [query, actions, keymap])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (event.key === 'Enter') { event.preventDefault(); items[active]?.run() }
  }

  return (
    <Dialog onClose={onClose} size="medium" className="palette" label="Commands">
      <input className="palette__input" autoFocus placeholder="Commands" value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
      <ul className="palette__list" role="listbox">
        {items.map((item, index) => (
          <li key={item.id} role="option" aria-selected={index === active} className={index === active ? 'is-active' : ''}
            onMouseMove={() => setActive(index)} onClick={item.run}>
            <span className="palette__glyph">{item.status ? <StatusGlyph status={item.status} /> : '›'}</span>
            <span className="palette__title">{item.title}</span>
            {item.detail && <span className="palette__detail">{item.detail}</span>}
            {item.keys && <kbd>{keyLabel(item.keys)}</kbd>}
          </li>
        ))}
        {items.length === 0 && <li className="palette__none">Nothing matches</li>}
      </ul>
    </Dialog>
  )
}

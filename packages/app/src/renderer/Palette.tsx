// Commands (⌘K): actions only, filtered as you type; going somewhere is the navigator's (⌘L). Arrow keys
// move, Enter runs, Escape closes. Every action that runs without more input is in it, with its shortcut; and each view
// in each place it fits that the window shows and it isn't in, to show it there (a view removed, one only offered).
import { useMemo } from 'react'
import { score } from './score.ts'
import { useRegistry } from './registry.tsx'
import { placingIn, scopedViews, usePlaced } from './placement.tsx'
import { NARROW_PLACES, WIDE_PLACES } from '../shared/layout.ts'
import { PLACE_PHRASES } from './view-menu.tsx'
import { useSelection } from './state.tsx'
import { runsBare } from './actions.tsx'
import { bound, useActions, useKeymap } from './keys.ts'
import { Picker } from './picker.tsx'

type Item = { id: string; title: string; group?: string; keys?: string; run(): void }

export function Palette({ onClose }: { onClose(): void }) {
  const registry = useRegistry()
  const { selection, machine, thread } = useSelection()
  const actions = useActions(selection?.machine)
  const [keymap] = useKeymap()

  // Every action that can run as it is: the palette dispatches it like a key would.
  // The app's and the selected machine's too: thread actions apply to the selected thread.
  const items = useMemo<Item[]>(() => actions.filter((a) => a.expose.includes('ui') && runsBare(a) && registry.router.offered(a.id) && a.id !== 'app.palette' && (!a.thread || selection)).map((a): Item => ({
    id: a.id, title: a.title, ...(bound(a, keymap) ? { keys: bound(a, keymap) } : {}), ...(a.thread && selection ? { group: 'This thread' } : {}),
    run: () => void registry.router.dispatch(a.id, {}, { source: 'palette' }).catch((error) => console.error(error)),
  })), [actions, keymap])
  // The views the selected thread sees (its profile's too), and the window's.
  const where = selection && machine && thread ? { machine: machine.id, thread } : undefined
  const { placed, narrow } = usePlaced(where)
  const placings = useMemo<Item[]>(() => {
    return scopedViews(registry, where).flatMap((view) =>
      view.fits.filter((place) => (narrow ? NARROW_PLACES : WIDE_PLACES).includes(place) && !placed[place].includes(view.id)).map((place): Item => ({
        id: `layout.place:${view.id}:${place}`, title: `Show ${view.title} ${PLACE_PHRASES[place]}`, group: 'Views',
        run: () => void registry.router.dispatch('layout.place', { view: view.id, place, on: true, ...(narrow ? { narrow } : {}), ...placingIn(where) }, { source: 'palette' }).catch((error) => console.error(error)),
      })))
  }, [placed, narrow])

  // Browsing, the window's commands, then the thread's, then the views to show; searching, the thread's say so.
  const all = useMemo(() => [...items.filter((item) => !item.group), ...items.filter((item) => item.group), ...placings], [items, placings])
  return (
    <Picker label="Commands" placeholder="Commands" items={all} onClose={onClose} group={(item) => item.group}
      // Browsing, every one; searching, the best 50.
      filter={(list, query) => !query.trim() ? list : list.map((item) => ({ item, rank: score(item.title, query) }))
        .filter(({ rank }) => rank > 0).sort((a, b) => b.rank - a.rank).map(({ item }) => item).slice(0, 50)}
      row={(item, { grouped }) => ({
        key: item.id, title: item.title,
        ...(!grouped && item.group === 'This thread' ? { detail: 'this thread' } : {}), ...(item.keys ? { keys: item.keys } : {}),
      })}
      onPick={(item) => { onClose(); item.run() }} />
  )
}

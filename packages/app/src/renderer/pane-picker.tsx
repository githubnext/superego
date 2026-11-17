// The pane picker (⌘⇧P): the panes the selected thread can open, as its pane menu lists them, filtered as you type;
// ⏎ opens the one lit beside the thread.
import type { ThreadInfo } from '@superego/protocol'
import { useRegistry } from './registry.tsx'
import { paneMenu, useLayout } from './placement.tsx'
import { Picker } from './picker.tsx'
import { score } from './score.ts'

type Kind = { kind: string; title: string }

export function PanePicker({ machine, thread, onClose }: { machine: string; thread: ThreadInfo; onClose(): void }) {
  const registry = useRegistry()
  const where = { machine, thread }
  const kinds = paneMenu(registry, useLayout(where).placed, where)
  const open = ({ kind, title }: Kind) => {
    onClose()
    // A failure shows in the action log, as every dispatch's does.
    registry.router.dispatch('pane.open', { thread: thread.id, kind }, { machine, source: 'pane picker' }).catch((error) => console.error(`Opening ${title}`, error))
  }
  return (
    <Picker<Kind> label="Open a pane" className="pane-picker" placeholder={`Open a pane beside ${thread.title}`} items={kinds} onClose={onClose}
      filter={(all, query) => all.map((item) => ({ item, rank: score(item.title, query) })).filter((m) => m.rank > 0).sort((a, b) => b.rank - a.rank).map((m) => m.item)}
      row={({ kind, title }) => ({ key: kind, title })}
      empty={kinds.length ? 'No pane by that name' : 'No panes to open here'}
      onPick={open} />
  )
}

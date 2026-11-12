/// <reference path="./env.d.ts" />
// links, UI half: ⌃U lists the links in the selected thread's transcript, newest first; typing narrows them. ⏎ follows
// one as a click would, ⌘⏎ opens it in a pane where it can be. The first nine take ⌃1–⌃9 (⌃⌘ for the pane).
import { useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { defineAction, defineUiExtension, keyLabel, useSelection } from '@superego/app/ui'
import { Dialog } from '@superego/ui'
import { filter, linksIn, newestFirst, short, type Link } from './links.ts'
import './styles.css'

let shown = false
const listeners = new Set<() => void>()
const show = (next: boolean) => { shown = next; for (const listener of listeners) listener() }
const useShown = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => shown)

export default defineUiExtension({
  name: 'links',
  setup(superego) {
    superego.slot('overlay', Links)
    superego.action(defineAction({ id: 'links.list', title: 'Links in this thread…', runs: 'window', keys: 'ctrl+u', run: () => show(!shown) }))
  },
})

function Links() {
  const open = useShown()
  const { selection } = useSelection()
  if (!open || !selection) return null
  return <LinkList onClose={() => show(false)} />
}

/** ⌃1–⌃9 and ⌃⌘1–⌃⌘9: a digit with ⌃, by the key's place (⌃ may change what the key types). */
const digitOf = (event: KeyboardEvent) => event.ctrlKey && !event.altKey && /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(5)) : undefined

function LinkList({ onClose }: { onClose(): void }) {
  // As the transcript is now: the thread's own column, not a thread shown in a pane.
  const [all] = useState(() => {
    const transcript = document.querySelector('[data-column="thread"] .transcript')
    return transcript ? newestFirst(linksIn(transcript)) : []
  })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => filter(all, query), [all, query])
  const follow = (link: Link | undefined, beside: boolean) => {
    if (!link || (beside && !link.beside)) return
    onClose()
    if (beside) link.beside!()
    else link.open()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const digit = digitOf(event)
    if (digit !== undefined) { event.preventDefault(); follow(matches[digit - 1], event.metaKey); return }
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) { event.preventDefault(); setActive((i) => Math.min(i + 1, matches.length - 1)) }
    if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) { event.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    if (event.key === 'Enter') { event.preventDefault(); follow(matches[active], event.metaKey) }
  }
  return (
    <Dialog onClose={onClose} size="medium" className="palette links" label="Links">
      <input className="palette__input" autoFocus placeholder="Links in this thread" value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
      <ul className="palette__list" role="listbox">
        {matches.map((link, index) => (
          <li key={`${link.kind}:${link.target}`} role="option" aria-selected={index === active} className={index === active ? 'is-active' : ''}
            onMouseMove={() => setActive(index)} onClick={(e) => follow(link, e.metaKey)}>
            <span className="palette__title">{link.text}</span>
            {link.text !== link.target && <span className="palette__detail links__target">{link.kind === 'web' ? short(link.target) : link.target}</span>}
            {index < 9 && <kbd>{keyLabel(`ctrl+${index + 1}`)}</kbd>}
          </li>
        ))}
        {matches.length === 0 && <li className="palette__none">{all.length ? 'Nothing matches' : 'No links in this thread yet'}</li>}
      </ul>
      <div className="links__keys"><span><kbd>{keyLabel('enter')}</kbd> open</span><span><kbd>{keyLabel('mod+enter')}</kbd> in a pane</span></div>
    </Dialog>
  )
}

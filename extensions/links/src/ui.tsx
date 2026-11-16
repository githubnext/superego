// links, UI half: ⌃O lists the links in the selected thread's transcript, newest first; typing narrows them. ⏎ follows
// one as a click would, ⌘⏎ opens it in a pane where it can be. The first nine take ⌃1–⌃9 (⌃⌘ for the pane).
import { useState } from 'react'
import { defineAction, defineUiExtension, keyLabel, Picker, transcriptLinks, useSelection, type Store } from '@superego/app/ui'
import { filter, newestFirst } from './links.ts'
import { about } from './shared.ts'
import './styles.css'

/** Whether the list is open (set in setup). */
let shown: Store<boolean>

export default defineUiExtension({
  ...about,
  setup(superego) {
    shown = superego.store<boolean>('shown', false)
    superego.slot('overlay', Links)
    // The links of the thread shown: only while one is.
    superego.action(defineAction({ id: 'links.list', title: 'Links in this thread…', keys: 'ctrl+o', when: (c) => Boolean(c.selection), run: () => shown.set((open) => !open) }))
  },
})

function Links() {
  const open = shown.use()
  const { selection } = useSelection()
  if (!open || !selection) return null
  return <LinkList machine={selection.machine} thread={selection.thread} onClose={() => shown.set(false)} />
}

function LinkList({ machine, thread, onClose }: { machine: string; thread: string; onClose(): void }) {
  // As the transcript is now: the links its messages drew, each claimed by what opens it.
  const [all] = useState(() => newestFirst(transcriptLinks(machine, thread)))
  return (
    <Picker label="Links" className="links" placeholder="Links in this thread" items={all} filter={filter} digits onClose={onClose}
      empty={all.length ? 'Nothing matches' : 'No links in this thread yet'}
      row={(link) => ({ key: link.href, title: link.text, ...(link.text !== link.target ? { detail: link.target } : {}) })}
      onPick={(link, { beside }) => { onClose(); void link.open(beside) }}
      footer={<div className="links__keys"><span><kbd>{keyLabel('enter')}</kbd> open</span><span><kbd>{keyLabel('mod+enter')}</kbd> in a pane</span></div>} />
  )
}

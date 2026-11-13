/// <reference path="./env.d.ts" />
// suggestions, UI half: what you might send next, numbered, over the composer once the agent has answered. Picking one
// puts it in the composer to change; in the empty composer ←/→ pick one, ⏎ sends it and ⇥ puts it in the box. ⌃1–⌃9
// send the one with that number, wherever the focus is in the thread.
import { useEffect } from 'react'
import { defineUiExtension, has, keyLabel, useComposer, useValue, type MachineEntry } from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { about, NEXT, type Suggested } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('composer.above', Suggestions, { order: 200 })
  },
})

function Suggestions({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const all = useValue<Record<string, Suggested>>(machine.id, machine.state === 'connected' && has(machine, 'ext:suggestions'), NEXT)
  const composer = useComposer()
  const shown = !thread.archived && thread.status.state !== 'working' && !composer.text ? all?.[thread.id]?.prompts ?? [] : []
  const offered = shown.join('\n')
  useEffect(() => { composer.suggest(offered ? offered.split('\n') : undefined); return () => composer.suggest(undefined) }, [offered, composer.suggest])
  if (!shown.length) return null
  return (
    <div className="suggestions" aria-label="Suggestions">
      {shown.map((prompt, index) => (
        <button key={prompt} type="button" className={`suggestions__item ${index === composer.picked ? 'is-picked' : ''}`}
          aria-keyshortcuts={index < 9 ? `Control+${index + 1}` : undefined} onClick={() => composer.fill(prompt)}>
          {index < 9 && <span className="suggestions__key" aria-hidden>{keyLabel(`ctrl+${index + 1}`)}</span>}{prompt}
        </button>
      ))}
    </div>
  )
}

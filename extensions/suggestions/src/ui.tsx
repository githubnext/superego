/// <reference path="./env.d.ts" />
// suggestions, UI half: what you might send next, over the composer once the agent has answered. Picking one puts it
// in the composer to send or change; ⇥ in the empty composer takes the first.
import { useEffect } from 'react'
import { defineUiExtension, has, useComposer, useValue, type MachineEntry } from '@superego/app/ui'
import type { ThreadInfo } from '@superego/protocol'
import { NEXT, type Suggested } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  name: 'suggestions',
  setup(superego) {
    superego.slot('composer.above', Suggestions, { order: 200 })
  },
})

function Suggestions({ machine, thread }: { machine: MachineEntry; thread: ThreadInfo }) {
  const all = useValue<Record<string, Suggested>>(machine.id, machine.state === 'connected' && has(machine, 'ext:suggestions'), NEXT)
  const composer = useComposer()
  const shown = !thread.archived && thread.status.state !== 'working' && !composer.text ? all?.[thread.id]?.prompts ?? [] : []
  const first = shown[0]
  useEffect(() => { composer.hint(first); return () => composer.hint(undefined) }, [first, composer.hint])
  if (!shown.length) return null
  return (
    <div className="suggestions" aria-label="Suggestions">
      {shown.map((prompt) => <button key={prompt} type="button" className="suggestions__item" onClick={() => composer.fill(prompt)}>{prompt}</button>)}
    </div>
  )
}

// suggestions, UI half: what you might send next, numbered, over the composer once the agent has answered. Picking one
// puts it in the composer to change; in the empty composer ←/→ pick one, ⏎ sends it and ⇥ puts it in the box. ⌃1–⌃9
// send the one with that number, wherever the focus is in the thread.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { defineUiExtension, keyLabel, useComposer, useValue, type MachineEntry } from '@superego/app/ui'
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
  const next = useValue<Suggested>(machine, NEXT, { scope: thread.id })
  const composer = useComposer()
  const shown = !thread.archived && thread.status.state !== 'working' && !composer.text ? next?.prompts ?? [] : []
  const offered = shown.join('\n')
  useEffect(() => { composer.suggest(offered ? offered.split('\n') : undefined); return () => composer.suggest(undefined) }, [offered, composer.suggest])
  const row = useRef<HTMLDivElement>(null)
  // One row, scrolled sideways: by a trackpad, or by a mouse's wheel turned into sideways, and to the pill ←/→ pick.
  // Its ends fade where there's more past them.
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const clip = () => {
      el.classList.toggle('is-clipped-start', el.scrollLeft > 1)
      el.classList.toggle('is-clipped-end', el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += event.deltaY
      event.preventDefault()
    }
    clip()
    const resized = new ResizeObserver(clip)
    resized.observe(el)
    el.addEventListener('scroll', clip, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    return () => { resized.disconnect(); el.removeEventListener('scroll', clip); el.removeEventListener('wheel', wheel) }
  }, [shown.length > 0, offered])
  useEffect(() => {
    if (composer.picked === undefined) return
    row.current?.children[composer.picked]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [composer.picked])
  if (!shown.length) return null
  return (
    <div className="suggestions" aria-label="Suggestions" ref={row}>
      {shown.map((prompt, index) => (
        <button key={prompt} type="button" className={`suggestions__item ${index === composer.picked ? 'is-picked' : ''}`}
          aria-keyshortcuts={index < 9 ? `Control+${index + 1}` : undefined} onClick={() => composer.fill(prompt)}>
          {index < 9 && <span className="suggestions__key" aria-hidden>{keyLabel(`ctrl+${index + 1}`)}</span>}{prompt}
        </button>
      ))}
    </div>
  )
}

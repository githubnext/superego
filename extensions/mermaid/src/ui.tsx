// mermaid, UI half: a ```mermaid fenced block is drawn as its diagram by Pele (pele.run), in messages and in rendered
// Markdown files. Its colours are the window's (styles.css), so a theme or appearance change needs no new drawing. A
// corner shows the source instead, or copies it. Half-written source, as a message streams in, keeps the last diagram
// that drew (or the source) quietly; source that still won't draw once the message is done is shown as it is, with
// a line saying why.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mounted, MountOptions } from 'pele'
import { copyText, defineUiExtension, type CodeBlockProps } from '@superego/app/ui'
import { CheckIcon, CodeIcon, CopyIcon, TreeStructureIcon } from '@superego/ui'
import { about } from './shared.ts'
import './styles.css'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.codeBlock('mermaid', MermaidBlock)
  },
})

/**
 * What Pele is given: nothing from the diagram reaches out (no links followed, no images loaded: a message's diagram is
 * the agent's words). Its labels at the UI's size, a step under the text's; fonts and colours come from the CSS.
 */
const OPTIONS: MountOptions = { links: false, images: false, fontSize: 14 }

type Pele = typeof import('pele')
/** Pele, once loaded: a chunk of its own, fetched as the first diagram shows rather than with the window. */
let pele: Pele | undefined
let loading: Promise<Pele> | undefined
export const loadPele = () => loading ??= import('pele').then((module) => (pele = module), (error: unknown) => {
  loading = undefined
  throw error
})

/**
 * Why it didn't draw, in a line: a parse error's message is its first line and last ("Parse error on line 3:", then
 * what was expected), with the source and a caret between, which the source shown already has.
 */
function reason(error: unknown) {
  const lines = (error instanceof Error ? error.message : String(error)).split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length > 1 ? `${lines[0]} ${lines.at(-1)}` : lines[0] ?? 'unknown error'
}

export function MermaidBlock({ code, compact, streaming }: CodeBlockProps) {
  const box = useRef<HTMLDivElement>(null)
  const diagram = useRef<Mounted | undefined>(undefined)
  /** Whether a diagram is drawn in `box`: the source's, or while it streams, the last that drew. */
  const [drawn, setDrawn] = useState(false)
  /** Why the source as it is now doesn't draw. */
  const [problem, setProblem] = useState<string>()
  const [source, setSource] = useState(false)
  const [ready, setReady] = useState(Boolean(pele))
  useEffect(() => {
    if (ready) return
    let alive = true
    loadPele().then(() => { if (alive) setReady(true) }, (error: unknown) => {
      console.error('Could not load Pele', error)
      if (alive) setProblem(`the renderer didn't load (${reason(error)})`)
    })
    return () => { alive = false }
  }, [ready])

  // Drawn before the frame shows: the source is checked first, so half-written source never replaces the diagram drawn.
  useLayoutEffect(() => {
    const element = box.current
    if (!element || !pele) return
    try {
      pele.parse(code)
      if (diagram.current) diagram.current.update(code, OPTIONS)
      else diagram.current = pele.mount(element, code, OPTIONS)
      const error = diagram.current.error
      setProblem(error === undefined ? undefined : reason(error))
      if (error === undefined) setDrawn(true)
    } catch (error) {
      setProblem(reason(error))
    }
  }, [code, ready])
  useEffect(() => () => { diagram.current?.destroy(); diagram.current = undefined }, [])

  // While it streams, what doesn't parse yet is only unfinished: no note, the last diagram (or the source) stays.
  const failed = problem !== undefined && !streaming
  const showing = drawn && !failed && !source ? 'diagram' : 'source'
  return (
    <div className={`mermaid${compact ? ' mermaid--compact' : ''}`} data-showing={showing}>
      <div ref={box} className="mermaid__diagram" hidden={showing !== 'diagram'} />
      {showing === 'source' && <pre className="mermaid__source"><code className="language-mermaid">{code}</code></pre>}
      {failed && <p className="mermaid__problem" title={problem}>Could not render diagram: {problem}</p>}
      <div className="mermaid__tools">
        {drawn && !failed && (
          <button type="button" className="mermaid__tool" aria-label={source ? 'Show diagram' : 'Show source'} title={source ? 'Show diagram' : 'Show source'}
            aria-pressed={source} onClick={() => setSource((on) => !on)}>
            {source ? <TreeStructureIcon aria-hidden /> : <CodeIcon aria-hidden />}
          </button>
        )}
        <CopyButton code={code} />
      </div>
    </div>
  )
}

/** Copies the source: blue with a check once it has, as a code block's button. */
function CopyButton({ code }: { code: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  // Each click keeps the feedback up for its full time, even mid-way through the last one's.
  const [click, setClick] = useState(0)
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? 1600 : 2400)
    return () => clearTimeout(timer)
  }, [state, click])
  const copy = () => {
    setClick((n) => n + 1)
    copyText(code).then(() => setState('copied'), (error: unknown) => { console.error(error); setState('failed') })
  }
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy source'
  return (
    <button type="button" className={`mermaid__tool${state !== 'idle' ? ` is-${state}` : ''}`} aria-label={label} title={label} onClick={copy}>
      {state === 'copied' ? <CheckIcon weight="bold" aria-hidden /> : <CopyIcon aria-hidden />}
    </button>
  )
}

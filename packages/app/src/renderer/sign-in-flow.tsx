// A sign-in flow as the window draws it: a provider's (Settings → Providers), or an extension's own (`superego.auth.flow`
// in its daemon half, an MCP server's, say). The flow runs on its machine; this follows what it says (`auth.event`),
// opens the page it gives in the browser, asks what it asks (answered with `auth.respond`), and stops it on Cancel, or
// once it's taken away unfinished (its row closed): nothing is left waiting on the browser, holding a port.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthEvent, AuthPrompt, Notifications } from '@superego/protocol'
import { autoFocusOnOpen, Button, TextField } from '@superego/ui'
import { copyText } from './copy-text.ts'
import { machine as client } from './client.ts'
import { useRegistry } from './registry.tsx'

/** The sign-in flow a `SignInFlow` runs: where, what to, and how it starts. */
export type SignInFlowProps = {
  /** The machine the flow runs on. */
  machine: string
  /** What it's signing in to, as its heading: "Signing in to Linear". */
  title: ReactNode
  /**
   * Start it: dispatch the action that does (`auth.signIn`, or an extension's, answering with `auth.flow`'s `{ flow }`).
   * Called once, as the component mounts; a throw ends it, failed, with its message.
   */
  start(): Promise<{ flow: string }>
  /** Close was pressed, once it ended. */
  onClose(): void
  /** It ended signed in. */
  onDone?(): void
}

/** A sign-in flow, from start to its end: mount it to start one, and take it away on `onClose`. */
export function SignInFlow({ machine, title, start, onClose, onDone }: SignInFlowProps) {
  const dispatch = useRegistry().router.dispatch
  const [flow, setFlow] = useState<string>()
  const [events, setEvents] = useState<AuthEvent[]>([])
  // Events heard before `start` answered with the flow's id: kept by flow, and taken once it's known.
  const heard = useRef(new Map<string, AuthEvent[]>())
  const id = useRef<string | undefined>(undefined)
  const started = useRef(false)
  // Taken away (unmounted), and whether it had ended by then.
  const gone = useRef(false)
  const ended = useRef(false)
  const cancel = (flow: string) => dispatch('auth.cancel', { flow }, { machine, source: 'settings' })
    .catch((error: Error) => console.error(`Stopping the sign-in ${flow} failed`, error))

  useEffect(() => client(machine).on('auth.event', ({ flow: from, event }: Notifications['auth.event']) => {
    if (id.current === undefined) return void heard.current.set(from, [...heard.current.get(from) ?? [], event])
    if (from !== id.current) return
    setEvents((list) => [...list, event])
    // Its page, in the browser, as soon as the flow has one.
    if (event.type === 'auth_url') window.open(event.url, '_blank')
  }), [machine])

  useEffect(() => {
    gone.current = false
    if (!started.current) {
      started.current = true
      start().then(({ flow }) => {
        id.current = flow
        if (gone.current) return void cancel(flow)
        const early = heard.current.get(flow) ?? []
      heard.current.clear()
        setFlow(flow)
        setEvents(early)
        const page = early.find((event) => event.type === 'auth_url')
        if (page) window.open(page.url, '_blank')
      }, (error: Error) => setEvents([{ type: 'failed', message: error.message }]))
    }
    return () => {
      gone.current = true
      if (id.current && !ended.current) void cancel(id.current)
    }
  }, [])

  const last = events.at(-1)
  const finished = last?.type === 'done' || last?.type === 'failed'
  ended.current = events.some((e) => e.type === 'done' || e.type === 'failed')
  useEffect(() => { if (last?.type === 'done') onDone?.() }, [last?.type])
  return (
    <div className="auth-flow">
      <div className="auth-flow__head">
        <b>{title}</b>
        {finished ? <Button onClick={onClose}>Close</Button>
          : <Button onClick={() => { if (flow) void dispatch('auth.cancel', { flow }, { machine, source: 'settings' }) }}>Cancel</Button>}
      </div>
      <FlowEvents flow={flow} events={events} machine={machine} />
    </div>
  )
}

function FlowEvents({ flow, events, machine }: { flow?: string; events: AuthEvent[]; machine: string }) {
  const dispatch = useRegistry().router.dispatch
  const closed = new Set(events.flatMap((e) => e.type === 'prompt_closed' ? [e.id] : []))
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  // A page whose redirect can be pasted: the flow's own words on it say what the fallback below does.
  const pasted = events.some((e) => e.type === 'prompt' && e.prompt.type === 'manual_code')
  return (
    <div className="auth-flow__events">
      {events.map((event, index) => {
        switch (event.type) {
          case 'auth_url': return <p key={index}>A sign-in page opened in your browser. <a href={event.url} target="_blank" rel="noreferrer">Open it again</a>{event.instructions && !pasted ? ` — ${event.instructions}` : ''}</p>
          case 'device_code': return <DeviceCode key={index} code={event.userCode} page={event.verificationUri} />
          case 'info': return <p key={index}>{event.message}</p>
          case 'progress': return <p key={index} className="settings__note">{event.message}</p>
          case 'done': return <p key={index} className="auth-flow__done">Signed in.</p>
          case 'failed': return <p key={index} className="setting__error">{event.message}</p>
          case 'prompt':
            if (closed.has(event.id) || answered.has(event.id) || !flow) return null
            const answer = (value: string) => {
              setAnswered((set) => new Set(set).add(event.id))
              void dispatch('auth.respond', { flow, prompt: event.id, value }, { machine, source: 'settings' })
                .catch((error: Error) => console.error('Answering the sign-in failed', error))
            }
            // The browser's redirect comes back by itself (here, or caught by the app for another computer): pasting it
            // is for when it doesn't.
            if (event.prompt.type === 'manual_code') {
              return (
                <details key={index} className="auth-flow__fallback">
                  <summary>Browser didn't come back?</summary>
                  <PromptField prompt={{ ...event.prompt, message: 'Paste the address it ended on' }} onAnswer={answer} />
                </details>
              )
            }
            return <PromptField key={index} prompt={event.prompt} onAnswer={answer} />
          default: return null
        }
      })}
    </div>
  )
}

/**
 * A device sign-in's code, to enter on its page (every flow's, Copilot's, Codex's, Kimi's alike): large, selected whole
 * by a click or by reaching it from the keyboard (so ⌘C copies it), with a button that copies it. Opening the page
 * copies it too, ready to paste where the page asks for it.
 */
function DeviceCode({ code, page }: { code: string; page: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [click, setClick] = useState(0)
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), state === 'copied' ? 1600 : 2400)
    return () => clearTimeout(timer)
  }, [state, click])
  const copy = () => {
    setClick((n) => n + 1)
    copyText(code).then(() => setState('copied'), (error: Error) => { console.error('Copying the sign-in code failed', error); setState('failed') })
  }
  return (
    <div className="auth-flow__device">
      <p>Enter this code at <a href={page} target="_blank" rel="noreferrer" onClick={copy}>{page.replace(/^https:\/\//, '')}</a>:</p>
      <div className="auth-flow__row">
        <code className="auth-flow__code" tabIndex={0} onFocus={(e) => document.getSelection()?.selectAllChildren(e.currentTarget)}>{code}</code>
        <Button onClick={copy}>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}</Button>
      </div>
    </div>
  )
}

/**
 * A question the flow asks. What a blank answer means is the flow's to say ("blank for github.com"): a text one goes
 * as it is, blank too. A key or a code is never blank: nothing goes until there's one.
 */
function PromptField({ prompt, onAnswer }: { prompt: AuthPrompt; onAnswer(value: string): void }) {
  const input = useRef<HTMLInputElement>(null)
  if (prompt.type === 'select') {
    return <div className="auth-flow__prompt"><p>{prompt.message}</p>{prompt.options.map((o) => <Button key={o.id} onClick={() => onAnswer(o.id)}>{o.label}</Button>)}</div>
  }
  return (
    <form className="auth-flow__prompt" onSubmit={(e) => {
      e.preventDefault()
      const value = input.current?.value ?? ''
      if (value || prompt.type === 'text') onAnswer(value)
    }}>
      <label>{prompt.message}</label>
      <div className="auth-flow__row">
        <TextField ref={input} autoFocus={autoFocusOnOpen()} type={prompt.type === 'secret' ? 'password' : 'text'} placeholder={prompt.placeholder} />
        <Button type="submit" variant="primary">Continue</Button>
      </div>
    </form>
  )
}

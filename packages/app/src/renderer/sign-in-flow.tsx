// A sign-in flow as the window draws it: a provider's (Settings → Providers), or an extension's own (`superego.auth.flow`
// in its daemon half, an MCP server's, say). The flow runs on its machine; this follows what it says (`auth.event`),
// opens the page it gives in the browser, asks what it asks (answered with `auth.respond`), and stops it on Cancel.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AuthEvent, AuthPrompt, Notifications } from '@superego/protocol'
import { Button, TextField } from '@superego/ui'
import { machine as client } from './client.ts'
import { useRegistry } from './extension.tsx'

export type SignInFlowProps = {
  /** The machine the flow runs on. */
  machine: string
  /** What it's signing in to, as its heading: "Signing in to Linear". */
  title: ReactNode
  /**
   * Start it: dispatch the action that does (`auth.login`, or an extension's, answering with `auth.flow`'s `{ flow }`).
   * Called once, as the component mounts; a throw ends it, failed, with its message.
   */
  start(): Promise<{ flow: string }>
  /** Close was pressed, once it ended. */
  onClose(): void
}

/** A sign-in flow, from start to its end: mount it to start one, and take it away on `onClose`. */
export function SignInFlow({ machine, title, start, onClose }: SignInFlowProps) {
  const dispatch = useRegistry().router.dispatch
  const [flow, setFlow] = useState<string>()
  const [events, setEvents] = useState<AuthEvent[]>([])
  // Events heard before `start` answered with the flow's id: kept by flow, and taken once it's known.
  const heard = useRef(new Map<string, AuthEvent[]>())
  const id = useRef<string | undefined>(undefined)
  const started = useRef(false)

  useEffect(() => client(machine).on('auth.event', ({ flow: from, event }: Notifications['auth.event']) => {
    if (id.current === undefined) return void heard.current.set(from, [...heard.current.get(from) ?? [], event])
    if (from !== id.current) return
    setEvents((list) => [...list, event])
    // Its page, in the browser, as soon as the flow has one.
    if (event.type === 'auth_url') window.open(event.url, '_blank')
  }), [machine])

  useEffect(() => {
    if (started.current) return
    started.current = true
    start().then(({ flow }) => {
      id.current = flow
      const early = heard.current.get(flow) ?? []
      heard.current.clear()
      setFlow(flow)
      setEvents(early)
      const page = early.find((event) => event.type === 'auth_url')
      if (page) window.open(page.url, '_blank')
    }, (error: Error) => setEvents([{ type: 'failed', message: error.message }]))
  }, [])

  const last = events.at(-1)
  const finished = last?.type === 'done' || last?.type === 'failed'
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
  return (
    <div className="auth-flow__events">
      {events.map((event, index) => {
        switch (event.type) {
          case 'auth_url': return <p key={index}>A sign-in page opened in your browser. <a href={event.url} target="_blank" rel="noreferrer">Open it again</a>{event.instructions ? ` — ${event.instructions}` : ''}</p>
          case 'device_code': return <p key={index}>Enter <code>{event.userCode}</code> at <a href={event.verificationUri} target="_blank" rel="noreferrer">{event.verificationUri}</a></p>
          case 'info': return <p key={index}>{event.message}</p>
          case 'progress': return <p key={index} className="settings__note">{event.message}</p>
          case 'done': return <p key={index} className="auth-flow__done">Signed in.</p>
          case 'failed': return <p key={index} className="setting__error">{event.message}</p>
          case 'prompt':
            if (closed.has(event.id) || answered.has(event.id) || !flow) return null
            return <PromptField key={index} prompt={event.prompt} onAnswer={(value) => {
              setAnswered((set) => new Set(set).add(event.id))
              void dispatch('auth.respond', { flow, prompt: event.id, value }, { machine, source: 'settings' })
            }} />
          default: return null
        }
      })}
    </div>
  )
}

function PromptField({ prompt, onAnswer }: { prompt: AuthPrompt; onAnswer(value: string): void }) {
  const input = useRef<HTMLInputElement>(null)
  if (prompt.type === 'select') {
    return <div className="auth-flow__prompt"><p>{prompt.message}</p>{prompt.options.map((o) => <Button key={o.id} onClick={() => onAnswer(o.id)}>{o.label}</Button>)}</div>
  }
  return (
    <form className="auth-flow__prompt" onSubmit={(e) => { e.preventDefault(); if (input.current?.value) onAnswer(input.current.value) }}>
      <label>{prompt.message}</label>
      <div className="auth-flow__row">
        <TextField ref={input} autoFocus type={prompt.type === 'secret' ? 'password' : 'text'} placeholder={prompt.placeholder} />
        <Button type="submit" variant="primary">Continue</Button>
      </div>
    </form>
  )
}

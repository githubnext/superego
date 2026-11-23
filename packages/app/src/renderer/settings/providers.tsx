// Settings → a machine → Providers: signing in and out of each, adding OpenAI-compatible ones of the user's own, and
// what's waiting on one that turned the machine away. Those signed in come first; the rest (some forty) after a search
// field, a line each.
import { useEffect, useRef, useState } from 'react'
import { AUTH_REJECTED, type ProviderAuthInfo, type ProviderRejection, type SectionInfo } from '@superego/protocol'
import { Button, TextField } from '@superego/ui'
import { waitingPhrase } from '../../shared/notifications.ts'
import { useValue } from '../client.ts'
import { useRegistry } from '../registry.tsx'
import { takeProviderFocus } from '../provider-focus.ts'
import { SignInFlow } from '../sign-in-flow.tsx'
import { useMachines } from '../state.tsx'
import { has } from '../client.ts'
import { openSetup } from '../Setup.tsx'
import { ProviderForm } from './provider-form.tsx'

export function Providers({ target, section }: { target: string; section: SectionInfo }) {
  const dispatch = useRegistry().router.dispatch
  const providers = (section.data ?? []) as ProviderAuthInfo[]
  // The sign-in going on, if one is: each new one drawn afresh (`n`).
  const [signing, setSigning] = useState<{ provider: string; type: 'api_key' | 'oauth'; key?: string; n: number }>()
  // Opened to sign in to one again ("Sign in again"): there, with its key's field open when it takes a key.
  const [focused] = useState(() => takeProviderFocus(target))
  const [keyFor, setKeyFor] = useState<string | undefined>(() => providers.find((p) => p.id === focused && p.apiKey && !p.keyFlow && !p.oauth)?.id)
  const [query, setQuery] = useState('')
  // The provider being added (`true`) or changed (its id).
  const [editing, setEditing] = useState<true | string>()
  const [problem, setProblem] = useState<{ provider: string; message: string }>()
  const focusedRow = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => { (focused === '' ? top : focusedRow).current?.scrollIntoView({ block: focused === '' ? 'start' : 'center' }) }, [])
  const machine = useMachines().find((m) => m.id === target)
  // A key is tried before it's kept, where the machine can.
  const check = has(machine, 'model-setup')
  const rejected = useValue<ProviderRejection[]>(machine, AUTH_REJECTED)
  const start = (provider: string, type: 'api_key' | 'oauth', key?: string) =>
    setSigning((current) => ({ provider, type, ...(key ? { key } : {}), n: (current?.n ?? 0) + 1 }))
  const run = (provider: string, id: string, params: Record<string, unknown>) =>
    dispatch(id, params, { machine: target, source: 'settings' }).catch((error: Error) => {
      console.error(`${id} for ${provider} failed`, error)
      setProblem({ provider, message: error.message })
    })

  const byName = (a: ProviderAuthInfo, b: ProviderAuthInfo) => a.name.localeCompare(b.name)
  const isUp = (p: ProviderAuthInfo) => Boolean(p.auth || p.stored || p.custom || rejected?.some((r) => r.provider === p.id))
  const up = providers.filter(isUp).sort(byName)
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const rest = providers.filter((p) => !isUp(p) && words.every((w) => `${p.name} ${p.id}`.toLowerCase().includes(w))).sort(byName)

  const row = (provider: ProviderAuthInfo, compact: boolean) => {
    const rejection = rejected?.find((r) => r.provider === provider.id)
    return (
      <div key={provider.id}>
        <div className={`provider ${compact ? 'is-compact' : ''} ${provider.id === focused ? 'is-focused' : ''}`} ref={provider.id === focused ? focusedRow : undefined}>
          <div className="setting__label">
            <div>{provider.name}</div>
            <div className="settings__note">{describe(provider)}</div>
            {rejection && <div className="setting__error">{rejection.summary}. {waitingPhrase(rejection.threads.length)}</div>}
            {problem?.provider === provider.id && <div className="setting__error">{problem.message}</div>}
          </div>
          <div className="provider__actions">
            {keyFor === provider.id ? (
              <form onSubmit={(e) => { e.preventDefault(); const key = new FormData(e.currentTarget).get('key') as string; setKeyFor(undefined); if (key) start(provider.id, 'api_key', key) }}>
                <TextField name="key" type="password" autoFocus placeholder={provider.env?.length === 1 ? `API key, or set ${provider.env[0]}` : 'API key'}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setKeyFor(undefined) } }} />
              </form>
            ) : (
              <>
                {provider.oauth && <Button onClick={() => start(provider.id, 'oauth')}>{provider.oauth}</Button>}
                {provider.apiKey && <Button onClick={() => provider.keyFlow ? start(provider.id, 'api_key') : setKeyFor(provider.id)}>{provider.keyFlow ? 'Set up…' : 'API key…'}</Button>}
                {provider.stored && <Button onClick={() => void run(provider.id, 'auth.signOut', { provider: provider.id })}>Sign out</Button>}
                {provider.custom && <Button onClick={() => setEditing(provider.id)}>Edit…</Button>}
                {provider.custom && <Button onClick={() => void run(provider.id, 'providers.remove', { provider: provider.id })}>Remove</Button>}
                {rejection && !rejection.retrying && <Button onClick={() => void run(provider.id, 'auth.retry', { provider: provider.id })}>Retry now</Button>}
              </>
            )}
          </div>
        </div>
        {editing === provider.id && <ProviderForm target={target} editing={provider} onDone={() => setEditing(undefined)} />}
        {signing?.provider === provider.id && (
          <SignInFlow
            key={signing.n} machine={target}
            title={`Signing in to ${provider.name}`}
            start={() => dispatch('auth.signIn', { provider: signing.provider, type: signing.type, ...(signing.key ? { key: signing.key } : {}), ...(check && signing.type === 'api_key' ? { check } : {}) }, { machine: target, source: 'settings' }) as Promise<{ flow: string }>}
            onClose={() => setSigning(undefined)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="providers" ref={top}>
      {check && <div className="providers__setup"><Button onClick={() => openSetup(target)}>Set up models…</Button></div>}
      {up.map((provider) => row(provider, false))}
      <div className="providers__find">
        <TextField type="search" placeholder="Search providers" aria-label="Search providers" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button onClick={() => setEditing(true)}>Add a provider…</Button>
      </div>
      {editing === true && <ProviderForm target={target} onDone={() => setEditing(undefined)} />}
      {rest.map((provider) => row(provider, true))}
      {words.length > 0 && !rest.length && <p className="settings__note">No provider matches “{query.trim()}”.</p>}
    </div>
  )
}

function describe(provider: ProviderAuthInfo) {
  const models = `${provider.models} model${provider.models === 1 ? '' : 's'}`
  if (!provider.auth) return models
  const how = provider.auth.type === 'oauth' ? 'Signed in' : provider.auth.source === 'no key' ? 'No key' : 'API key'
  const source = provider.auth.source && provider.auth.source !== 'no key' ? ` · ${provider.auth.source}` : ''
  return `${how}${source} · ${models}${provider.custom ? ` · ${provider.custom.baseUrl}` : ''}`
}

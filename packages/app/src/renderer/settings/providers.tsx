// Settings → a machine → Providers: signing in and out of each, and what's waiting on one that turned the machine away.
import { useEffect, useRef, useState } from 'react'
import { AUTH_REJECTED, type ProviderAuthInfo, type ProviderRejection, type SectionInfo } from '@superego/protocol'
import { Button, TextField } from '@superego/ui'
import { waitingPhrase } from '../../shared.ts'
import { useValue } from '../client.ts'
import { useRegistry } from '../extension.tsx'
import { takeProviderFocus } from '../provider-focus.ts'
import { SignInFlow } from '../sign-in-flow.tsx'
import { useMachines } from '../state.tsx'

export function Providers({ target, section }: { target: string; section: SectionInfo }) {
  const dispatch = useRegistry().router.dispatch
  const providers = (section.data ?? []) as ProviderAuthInfo[]
  // The sign-in going on, if one is: each new one drawn afresh (`n`).
  const [signing, setSigning] = useState<{ provider: string; type: 'api_key' | 'oauth'; key?: string; n: number }>()
  // Opened to sign in to one again ("Sign in again"): there, with its key's field open when it takes a key.
  const [focused] = useState(() => takeProviderFocus(target))
  const [keyFor, setKeyFor] = useState<string | undefined>(() => providers.find((p) => p.id === focused && p.apiKey && !p.oauth)?.id)
  const focusedRow = useRef<HTMLDivElement>(null)
  useEffect(() => { focusedRow.current?.scrollIntoView({ block: 'center' }) }, [])
  const rejected = useValue<ProviderRejection[]>(useMachines().find((m) => m.id === target), AUTH_REJECTED)
  const start = (provider: string, type: 'api_key' | 'oauth', key?: string) =>
    setSigning((current) => ({ provider, type, ...(key ? { key } : {}), n: (current?.n ?? 0) + 1 }))

  return (
    <div className="providers">
      {providers.map((provider) => {
        const rejection = rejected?.find((r) => r.provider === provider.id)
        return (
        <div key={provider.id} className={`provider ${provider.id === focused ? 'is-focused' : ''}`} ref={provider.id === focused ? focusedRow : undefined}>
          <div className="setting__label">
            <div>{provider.name}</div>
            <div className="settings__note">{describe(provider)}</div>
            {rejection && <div className="setting__error">{rejection.summary}. {waitingPhrase(rejection.threads.length)}</div>}
          </div>
          <div className="provider__actions">
            {keyFor === provider.id ? (
              <form onSubmit={(e) => { e.preventDefault(); const key = new FormData(e.currentTarget).get('key') as string; setKeyFor(undefined); if (key) start(provider.id, 'api_key', key) }}>
                <TextField name="key" type="password" autoFocus placeholder="API key" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setKeyFor(undefined) } }} />
              </form>
            ) : (
              <>
                {provider.oauth && <Button onClick={() => start(provider.id, 'oauth')}>{provider.oauth}</Button>}
                {provider.apiKey && <Button onClick={() => setKeyFor(provider.id)}>API key…</Button>}
                {provider.stored && <Button onClick={() => void dispatch('auth.signOut', { provider: provider.id }, { machine: target, source: 'settings' })}>Sign out</Button>}
                {rejection && !rejection.retrying && <Button onClick={() => void dispatch('auth.retry', { provider: provider.id }, { machine: target, source: 'settings' })}>Retry now</Button>}
              </>
            )}
          </div>
        </div>
        )
      })}
      {signing && (
        <SignInFlow
          key={signing.n} machine={target}
          title={`Signing in to ${providers.find((p) => p.id === signing.provider)?.name ?? signing.provider}`}
          start={() => dispatch('auth.signIn', { provider: signing.provider, type: signing.type, ...(signing.key ? { key: signing.key } : {}) }, { machine: target, source: 'settings' }) as Promise<{ flow: string }>}
          onClose={() => setSigning(undefined)}
        />
      )}
    </div>
  )
}

function describe(provider: ProviderAuthInfo) {
  if (!provider.auth) return 'Not signed in'
  const how = provider.auth.type === 'oauth' ? 'signed in' : 'API key'
  return `${how}${provider.auth.source ? ` · ${provider.auth.source}` : ''} · ${provider.models} models`
}


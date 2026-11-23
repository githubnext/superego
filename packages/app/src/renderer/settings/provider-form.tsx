// Settings → Providers' form, and setup's: an OpenAI-compatible provider of the user's own, added or changed.
import { useState } from 'react'
import type { ProviderAuthInfo } from '@superego/protocol'
import { Button, TextArea, TextField } from '@superego/ui'
import { useRegistry } from '../registry.tsx'

/**
 * Add an OpenAI-compatible provider, or change one added before (`editing`): its name, base URL, key, and models (one
 * id a line; those its endpoint lists when none are typed, or listed here with List models).
 */
export function ProviderForm({ target, editing, onDone }: { target: string; editing?: ProviderAuthInfo; onDone(saved?: string): void }) {
  const dispatch = useRegistry().router.dispatch
  const [name, setName] = useState(editing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(editing?.custom?.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [models, setModels] = useState(editing?.custom?.models.join('\n') ?? '')
  const [busy, setBusy] = useState<'listing' | 'saving'>()
  const [error, setError] = useState<string>()
  const call = async <T,>(what: 'listing' | 'saving', id: string, params: Record<string, unknown>): Promise<T | undefined> => {
    setBusy(what); setError(undefined)
    try { return await dispatch(id, params, { machine: target, source: 'settings' }) as T } catch (e) {
      console.error(`${id} failed`, e)
      setError((e as Error).message)
      return undefined
    } finally { setBusy(undefined) }
  }
  const list = async () => {
    const found = await call<{ models: string[] }>('listing', 'providers.models', { baseUrl, ...(key ? { key } : {}), ...(editing ? { provider: editing.id } : {}) })
    if (found) setModels(found.models.join('\n'))
  }
  const save = async () => {
    const ids = models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean)
    const saved = await call<{ id: string }>('saving', 'providers.save', { ...(editing ? { id: editing.id } : {}), name, baseUrl, ...(key ? { key } : {}), ...(ids.length ? { models: ids } : {}) })
    if (saved) onDone(saved.id)
  }
  return (
    <form className="provider-form" onSubmit={(e) => { e.preventDefault(); void save() }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone() } }}>
      <label htmlFor="provider-name">Name</label>
      <TextField id="provider-name" autoFocus value={name} placeholder="Ollama" onChange={(e) => setName(e.target.value)} />
      <label htmlFor="provider-url">Base URL</label>
      <TextField id="provider-url" value={baseUrl} placeholder="http://localhost:11434/v1" onChange={(e) => setBaseUrl(e.target.value)} />
      <label htmlFor="provider-key">API key</label>
      <TextField id="provider-key" type="password" value={key} placeholder={editing?.stored ? 'Unchanged' : 'Optional'} onChange={(e) => setKey(e.target.value)} />
      <label htmlFor="provider-models">Models</label>
      <div className="provider-form__models">
        <TextArea id="provider-models" value={models} placeholder="One id a line; blank for all it lists" onChange={(e) => setModels(e.target.value)} />
        <Button type="button" disabled={!baseUrl.trim() || busy !== undefined} onClick={() => void list()}>{busy === 'listing' ? 'Listing…' : 'List models'}</Button>
      </div>
      <div className="provider-form__foot">
        {error && <span className="setting__error">{error}</span>}
        <Button type="button" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || !baseUrl.trim() || busy !== undefined}>{busy === 'saving' ? 'Saving…' : editing ? 'Save' : 'Add'}</Button>
      </div>
    </form>
  )
}

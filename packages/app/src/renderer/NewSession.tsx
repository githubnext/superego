// The New session dialog: what to work on, where (machine and folder), and with which model and thinking. Everything
// but the folder is optional; unset choices follow that machine's settings. ⌘⏎ starts it.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelCatalog } from '@mu/protocol'
import { Button, Dialog, Select, TextArea, TextField } from '@mu/ui'
import { has, machine as client } from './client.ts'
import { shortPath } from './SessionView.tsx'
import { useAllSessions, useMachines, useSelection, type NewSessionStart } from './state.tsx'

const LAST = 'mu.newSession'
type Last = { machine?: string; cwd?: Record<string, string> }
const readLast = (): Last => { try { return JSON.parse(localStorage.getItem(LAST) ?? '{}') } catch { return {} } }

export function NewSessionDialog({ start, onClose }: { start: NewSessionStart; onClose(): void }) {
  const machines = useMachines().filter((m) => m.state === 'connected' && has(m, 'sessions'))
  const sessions = useAllSessions()
  const { select } = useSelection()
  const last = useMemo(readLast, [])
  const [machineId, setMachineId] = useState(start.machine ?? (machines.some((m) => m.id === last.machine) ? last.machine! : 'local'))
  const machine = machines.find((m) => m.id === machineId) ?? machines[0]
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState(start.cwd ?? last.cwd?.[machineId] ?? '')
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [thinking, setThinking] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // Each machine has its own models and default; what was picked on another doesn't carry over.
  useEffect(() => {
    setCatalog(undefined); setModel(null); setThinking(null)
    if (!machine) return
    let live = true
    client(machine.id).call('agent.models', {}).then((c) => { if (live) setCatalog(c) }, () => {})
    return () => { live = false }
  }, [machine?.id])

  /** Folders sessions on this machine worked in, most recent first. */
  const recent = useMemo(() => {
    const list = (sessions[machine?.id ?? ''] ?? []).slice().sort((a, b) => (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt))
    return [...new Set(list.map((s) => s.cwd))].slice(0, 6)
  }, [sessions, machine?.id])

  const chosen = catalog?.models.find((m) => m.value === (model ?? catalog.default.model))
  const levels = chosen?.thinking ?? []
  const defaultLabel = catalog?.default.model ? `Default · ${catalog.models.find((m) => m.value === catalog.default.model)?.label ?? catalog.default.model}` : 'Default'

  const create = async () => {
    if (!machine || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const created = await client(machine.id).call('session.create', {
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}),
        ...(model ? { model } : {}), ...(thinking && levels.length ? { thinking } : {}), ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      })
      localStorage.setItem(LAST, JSON.stringify({ machine: machine.id, cwd: { ...last.cwd, [machine.id]: created.cwd } } satisfies Last))
      onClose()
      select({ machine: machine.id, session: created.id })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
  }
  const browse = async () => {
    const picked = await window.mu.call('app', 'app.pickFolder', { defaultPath: cwd || undefined }) as string | null
    if (picked) setCwd(picked)
  }

  return (
    <Dialog onClose={onClose} title="New session" size="medium" className="new-session">
      <div className="new-session__body" onKeyDown={onKeyDown}>
        {machines.length === 0 ? <p className="new-session__note">No machine is connected.</p> : <>
          <TextArea ref={promptRef} autoFocus rows={4} maxRows={10} className="new-session__prompt" aria-label="Prompt"
            placeholder="What should it work on? (optional)" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

          <label className="new-session__field">
            <span>Project</span>
            <div className="new-session__row">
              <TextField aria-label="Project folder" placeholder="Folder (empty: home)" value={cwd} onChange={(e) => setCwd(e.target.value)} />
              {machine?.id === 'local' && <Button onClick={() => void browse()}>Browse…</Button>}
            </div>
          </label>
          {recent.length > 0 && (
            <div className="new-session__recent">
              {recent.map((dir) => <button key={dir} type="button" className={dir === cwd ? 'is-on' : ''} onClick={() => setCwd(dir)}>{shortPath(dir)}</button>)}
            </div>
          )}

          <div className="new-session__grid">
            {machines.length > 1 && (
              <label className="new-session__field"><span>Machine</span>
                <Select aria-label="Machine" options={machines.map((m) => ({ value: m.id, label: m.label }))} value={machine?.id ?? null}
                  onChange={(value) => { if (value) { setMachineId(value); setCwd(last.cwd?.[value] ?? '') } }} />
              </label>
            )}
            <label className="new-session__field"><span>Model</span>
              <Select aria-label="Model" options={catalog?.models ?? []} value={model} nullLabel={catalog ? defaultLabel : 'Loading…'} disabled={!catalog}
                onChange={(value) => { setModel(value); setThinking(null) }} />
            </label>
            {levels.length > 0 && (
              <label className="new-session__field"><span>Thinking</span>
                <Select aria-label="Thinking" options={levels.map((l) => ({ value: l, label: l }))} value={thinking}
                  nullLabel={catalog?.default.thinking ? `Default · ${catalog.default.thinking}` : 'Model default'} onChange={setThinking} />
              </label>
            )}
          </div>

          <label className="new-session__field">
            <span>Name</span>
            <TextField aria-label="Name" placeholder="From the prompt (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </>}
        {error && <p className="new-session__error">{error}</p>}
      </div>
      <footer className="new-session__foot">
        <span className="new-session__hint">{machine ? `${machine.label}${cwd ? ` · ${shortPath(cwd)}` : ''}` : ''}</span>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!machine || busy} onClick={() => void create()}>Start <kbd>⌘⏎</kbd></Button>
      </footer>
    </Dialog>
  )
}

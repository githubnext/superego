// The New thread dialog: what to work on, where (machine and folder), with which profile, model and thinking. Unset
// choices follow the folder's default profile and that machine's settings. ⌘⏎ starts it. A project's profile that
// isn't allowed yet (it runs that repo's code) can be allowed here, and started. Extensions add fields of their own
// (worktrees' checkbox), each sent as `options[<extension>]`.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Json, ModelCatalog, ProfileInfo, ThreadInfo } from '@superego/protocol'
import { useRegistry, type Registry } from './extension.tsx'
import { Contained } from './contained.tsx'
import { Button, Dialog, Select, TextArea, TextField } from '@superego/ui'
import { has, machine as client } from './client.ts'
import { shortPath } from './ThreadView.tsx'
import { useAllThreads, useMachines, useSelection, type NewThreadStart } from './state.tsx'

const LAST = 'superego.newThread'
type Last = { machine?: string; cwd?: Record<string, string> }
const readLast = (): Last => { try { return JSON.parse(localStorage.getItem(LAST) ?? '{}') } catch { return {} } }

/**
 * What a thread started beside `thread` takes after it: its machine and project, profile, model, thinking, and what
 * extensions' fields take from it (a worktree or not).
 */
export function startFrom(registry: Registry, machine: string, thread: ThreadInfo): NewThreadStart {
  const options: Record<string, Json> = {}
  for (const field of registry.newThreadFields) {
    const value = field.from?.(thread)
    if (value !== undefined) options[field.name] = value
  }
  return {
    machine, cwd: thread.session?.root ?? thread.cwd,
    ...(thread.profile ? { profile: thread.profile.name } : {}),
    ...(thread.chosen?.model ? { model: thread.chosen.model } : {}), ...(thread.chosen?.thinking ? { thinking: thread.chosen.thinking } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  }
}

export function NewThreadDialog({ start: asked, onClose }: { start: NewThreadStart; onClose(): void }) {
  const machines = useMachines().filter((m) => m.state === 'connected' && has(m, 'threads'))
  const threads = useAllThreads()
  const { select, selection, thread: shown } = useSelection()
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const last = useMemo(readLast, [])
  // It starts like the thread shown: asked for nothing in particular (⌘N, the title bar's button), or for its project
  // (the sidebar's + on its session). Asked for another, it starts there; asked for nothing with no thread shown, as last time.
  const [start] = useState(() => {
    if (!selection || !shown) return asked
    const like = startFrom(registry, selection.machine, shown)
    return !asked.machine && !asked.cwd ? like : asked.machine === like.machine && asked.cwd === like.cwd ? { ...like, ...asked } : asked
  })
  const [machineId, setMachineId] = useState(start.machine && machines.some((m) => m.id === start.machine) ? start.machine
    : machines.some((m) => m.id === last.machine) ? last.machine! : 'local')
  const machine = machines.find((m) => m.id === machineId) ?? machines[0]
  const [prompt, setPrompt] = useState('')
  const [cwd, setCwd] = useState(start.machine === machineId && start.cwd ? start.cwd : last.cwd?.[machineId] ?? '')
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [thinking, setThinking] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [error, setError] = useState<{ kind?: string; message: string }>()
  const [profiles, setProfiles] = useState<ProfileInfo[]>([])
  const [profile, setProfile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** What extensions' fields are set to, by extension. */
  const [options, setOptions] = useState<Record<string, Json>>(start.options ?? {})
  // Those the machine picked has (an optional one may be off there).
  const fields = registry.newThreadFields.filter((f) => has(machine, `ext:${f.name}`))
  const fieldOptions = Object.fromEntries(fields.flatMap((f) => options[f.name] === undefined ? [] : [[f.name, options[f.name]!]]))
  const promptRef = useRef<HTMLTextAreaElement>(null)

  // Each machine has its own models and default; what was picked on another doesn't carry over.
  useEffect(() => {
    setCatalog(undefined); setModel(null); setThinking(null)
    if (!machine) return
    let live = true
    client(machine.id).call('agent.models', {}).then((c) => {
      if (!live) return
      setCatalog(c)
      // On the machine it started on, the model and thinking it started with, where that machine has them.
      const from = machine.id === start.machine && c.models.find((m) => m.value === start.model)
      if (from) { setModel(from.value); if (start.thinking && from.thinking.includes(start.thinking)) setThinking(start.thinking) }
    }, () => {})
    return () => { live = false }
  }, [machine?.id])

  // The profiles a thread in this folder could start with, as the folder is typed (a moment after the last key).
  useEffect(() => {
    if (!machine) return
    let live = true
    const timer = setTimeout(() => {
      dispatch('profile.list', cwd.trim() ? { cwd: cwd.trim() } : {}, { machine: machine.id, source: 'new thread' })
        .then((list) => {
          if (!live) return
          const found = list as ProfileInfo[]
          setProfiles(found)
          // The profile it started with, while the folder is the one it started in.
          setProfile(start.profile && start.profile !== 'default' && cwd.trim() === start.cwd && found.some((p) => p.name === start.profile) ? start.profile : null)
        }, () => { if (live) setProfiles([]) })
    }, 250)
    return () => { live = false; clearTimeout(timer) }
  }, [machine?.id, cwd])
  const defaultProfile = profiles.find((p) => p.name === 'default')
  const picked = profiles.find((p) => p.name === (profile ?? 'default'))

  /** This machine's sessions (projects threads worked in), most recent first. */
  const recent = useMemo(() => {
    const list = (threads[machine?.id ?? ''] ?? []).slice().sort((a, b) => (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt))
    return [...new Set(list.map((t) => t.session?.root ?? t.cwd))].slice(0, 6)
  }, [threads, machine?.id])

  const chosen = catalog?.models.find((m) => m.value === (model ?? catalog.default.model))
  const levels = chosen?.thinking ?? []
  const defaultLabel = catalog?.default.model ? `Default · ${catalog.models.find((m) => m.value === catalog.default.model)?.label ?? catalog.default.model}` : 'Default'

  const create = async ({ allow = false } = {}) => {
    if (!machine || busy) return
    setBusy(true)
    setError(undefined)
    try {
      if (allow && picked) await dispatch('profile.allow', { ...(cwd.trim() ? { cwd: cwd.trim() } : {}), name: picked.name }, { machine: machine.id, source: 'new thread' })
      const created = await dispatch('thread.create', {
        ...(profile ? { profile } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}),
        ...(model ? { model } : {}), ...(thinking && levels.length ? { thinking } : {}), ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(Object.keys(fieldOptions).length ? { options: fieldOptions } : {}),
      }, { machine: machine.id, source: 'new thread' }) as ThreadInfo
      localStorage.setItem(LAST, JSON.stringify({ machine: machine.id, cwd: { ...last.cwd, [machine.id]: created.session?.root ?? created.cwd } } satisfies Last))
      onClose()
      select({ machine: machine.id, thread: created.id })
    } catch (e) {
      setError(e as { kind?: string; message: string })
      setBusy(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
  }
  const browse = async () => {
    const picked = await window.superego.call('app', 'app.pickFolder', { defaultPath: cwd || undefined }) as string | null
    if (picked) setCwd(picked)
  }

  return (
    <Dialog onClose={onClose} title="New thread" size="medium" className="new-thread">
      <div className="new-thread__body" onKeyDown={onKeyDown}>
        {machines.length === 0 ? <p className="new-thread__note">No machine is connected.</p> : <>
          <TextArea ref={promptRef} autoFocus rows={4} maxRows={10} className="new-thread__prompt" aria-label="Prompt"
            placeholder="What should it work on? (optional)" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

          <label className="new-thread__field">
            <span>Project</span>
            <div className="new-thread__row">
              <TextField aria-label="Project folder" placeholder="Folder (empty: home)" value={cwd} onChange={(e) => setCwd(e.target.value)} />
              {machine?.id === 'local' && !window.superego.web && <Button onClick={() => void browse()}>Browse…</Button>}
            </div>
          </label>
          {recent.length > 0 && (
            <div className="new-thread__recent">
              {recent.map((dir) => <button key={dir} type="button" className={dir === cwd ? 'is-on' : ''} onClick={() => setCwd(dir)}>{shortPath(dir)}</button>)}
            </div>
          )}

          <div className="new-thread__grid">
            {machines.length > 1 && (
              <label className="new-thread__field"><span>Machine</span>
                <Select aria-label="Machine" options={machines.map((m) => ({ value: m.id, label: m.label }))} value={machine?.id ?? null}
                  onChange={(value) => { if (value) { setMachineId(value); setCwd(last.cwd?.[value] ?? '') } }} />
              </label>
            )}
            {profiles.length > 0 && (
              <label className="new-thread__field"><span>Profile</span>
                <Select aria-label="Profile" value={profile}
                  options={profiles.filter((p) => p.name !== 'default').map((p) => ({ value: p.name, label: `${p.name}${p.scope === 'user' ? ' (yours)' : ''}` }))}
                  nullLabel={defaultProfile ? `default${defaultProfile.scope === 'user' ? ' (yours)' : ''}` : 'None'} onChange={setProfile} />
              </label>
            )}
            <label className="new-thread__field"><span>Model</span>
              <Select aria-label="Model" options={catalog?.models ?? []} value={model} nullLabel={catalog ? defaultLabel : 'Loading…'} disabled={!catalog}
                onChange={(value) => { setModel(value); setThinking(null) }} />
            </label>
            {levels.length > 0 && (
              <label className="new-thread__field"><span>Thinking</span>
                <Select aria-label="Thinking" options={levels.map((l) => ({ value: l, label: l }))} value={thinking}
                  nullLabel={catalog?.default.thinking ? `Default · ${catalog.default.thinking}` : 'Model default'} onChange={setThinking} />
              </label>
            )}
          </div>

          {machine && fields.map(({ name, component: Field }) => (
            <Contained key={name} name={name}><Field machine={machine} cwd={cwd.trim()} value={options[name]}
              onChange={(value) => setOptions(({ [name]: _was, ...rest }) => value === undefined ? rest : { ...rest, [name]: value })} /></Contained>
          ))}

          <label className="new-thread__field">
            <span>Name</span>
            <TextField aria-label="Name" placeholder="From the prompt (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </>}
        {picked && !picked.allowed && !error && (
          <p className="new-thread__note">The {picked.name} profile runs this project's own code. Starting will ask to allow it.</p>
        )}
        {error && (
          <div className="new-thread__error">
            <p>{error.message}</p>
            {error.kind === 'untrusted_profile' && <Button onClick={() => void create({ allow: true })}>Allow and start</Button>}
          </div>
        )}
      </div>
      <footer className="new-thread__foot">
        <span className="new-thread__hint">{machine ? `${machine.label}${cwd ? ` · ${shortPath(cwd)}` : ''}` : ''}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!machine || busy} onClick={() => void create()}>Start <kbd>⌘⏎</kbd></Button>
      </footer>
    </Dialog>
  )
}

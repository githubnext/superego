// The New thread dialog, in the order it's decided: where (the machine, then a folder on it), how (the profile, model and
// thinking; unset, the folder's default profile and that machine's settings), then what to work on, in the composer a
// thread has (files, skills, mentions). ⌃1–⌃7 go to each field, as labelled; ⏎ in the prompt or ⌘⏎ anywhere starts it.
// A project's profile that isn't allowed yet (it runs that repo's code) can be allowed here, and started. Extensions
// add fields of their own (worktrees' checkbox), each sent as `options[<extension>]`. Another kind of agent's model
// (Claude Agent's group, where the machine has it) picks the profile that runs on it, and a profile of such a kind
// offers that kind's models alone: a thread runs on one kind for its whole life.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Attachment, Json, ModelCatalog, ProfileInfo, ThreadInfo } from '@superego/protocol'
import { useRegistry, type Registry } from './registry.tsx'
import { Contained } from './contained.tsx'
import { autoFocusOnOpen, Button, Dialog, Select, TextField } from '@superego/ui'
import { has, machine as client } from './client.ts'
import { ProfileSelect } from './profile-pick.tsx'
import { useLocalState } from './local-state.ts'
import { useAllThreads, useMachines, useSelection, type NewThreadStart } from './state.tsx'
import { APP } from '../shared/app-settings.ts'
import { ctrlDigit, keyLabel } from './keys.ts'
import { ComposerBox } from './composer-box.tsx'
import { ModelPicker, withFavourites } from './model-picker.tsx'
import { FolderField, recentFolders, type FolderFieldHandle } from './folder-field.tsx'
import { NoModel } from './Setup.tsx'
import { useNarrow } from './media.ts'

/** The machine the last thread started from here was on. Every window's. */
type Last = { machine?: string }

/** Each field's key: ⌃ and its number, in the order they're shown. */
const KEYS = { machine: 1, folder: 2, profile: 3, model: 4, thinking: 5, prompt: 6, name: 7 } as const
type FieldName = keyof typeof KEYS

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
    machine, cwd: thread.project.root,
    ...(thread.profile ? { profile: thread.profile.name } : {}),
    ...(thread.chosen?.model ? { model: thread.chosen.model } : {}), ...(thread.chosen?.thinking ? { thinking: thread.chosen.thinking } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  }
}

/** A field with its label and its key (⌃1…), which goes to it. */
function Field({ name, label, children, className = '' }: { name: FieldName; label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`new-thread__field ${className}`} data-field={name}>
      <span className="new-thread__label">{label}<kbd>{keyLabel(`ctrl+${KEYS[name]}`)}</kbd></span>
      {children}
    </label>
  )
}

type Failure = { kind?: string; message: string }

export function NewThreadDialog({ start: asked, onClose }: { start: NewThreadStart; onClose(): void }) {
  const machines = useMachines().filter((m) => m.state === 'connected')
  const threads = useAllThreads()
  const { select, selection, thread: shown } = useSelection()
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const [last, setLast] = useLocalState<Last>('newThread', {}, { shared: true })
  // It starts like the thread shown: asked for nothing in particular (⌘N, the title bar's button), or for its project
  // (the sidebar's + on its project). Asked for another, it starts there; asked for nothing with no thread shown, as last time.
  const [start] = useState(() => {
    if (!selection || !shown) return asked
    const like = startFrom(registry, selection.machine, shown)
    return !asked.machine && !asked.cwd ? like : asked.machine === like.machine && asked.cwd === like.cwd ? { ...like, ...asked } : asked
  })
  const [machineId, setMachineId] = useState(start.machine && machines.some((m) => m.id === start.machine) ? start.machine
    : machines.some((m) => m.id === last.machine) ? last.machine! : 'local')
  const machine = machines.find((m) => m.id === machineId) ?? machines[0]

  // The folders each machine's threads worked in, archived ones too (asked for once a machine is picked).
  const [archived, setArchived] = useState<Record<string, ThreadInfo[] | Failure>>({})
  useEffect(() => {
    if (!machine || archived[machine.id]) return
    const id = machine.id
    client(id).call('thread.list', { archived: true }).then(
      (list) => setArchived((was) => ({ ...was, [id]: list })),
      (error: Error) => {
        console.error(`Listing ${id}'s archived threads for their folders failed`, error)
        setArchived((was) => ({ ...was, [id]: { message: `Folders of archived threads aren't listed: ${error.message}` } }))
      })
  }, [machine?.id])
  const foldersOn = (id: string) => {
    const old = archived[id]
    return recentFolders([...threads[id] ?? [], ...Array.isArray(old) ? old : []])
  }
  const folders = useMemo(() => machine ? foldersOn(machine.id) : [], [threads, archived, machine?.id])
  const archivedProblem = machine && !Array.isArray(archived[machine.id]) ? archived[machine.id] as Failure | undefined : undefined

  const [cwd, setCwd] = useState(start.machine === machineId && start.cwd ? start.cwd : foldersOn(machineId)[0] ?? '')
  const [draft, setDraft] = useLocalState('newThread.draft', '', { shared: true })
  const [files, setFiles] = useState<Attachment[]>([])
  const [title, setTitle] = useState('')
  const [model, setModel] = useState<string | null>(null)
  const [thinking, setThinking] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | Failure>()
  const [error, setError] = useState<Failure>()
  const [profiles, setProfiles] = useState<ProfileInfo[] | Failure>()
  const [profile, setProfile] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const narrow = useNarrow()
  /** What extensions' fields are set to, by extension. */
  const [options, setOptions] = useState<Record<string, Json>>(start.options ?? {})
  // Those the machine picked has (an optional one may be off there).
  const fields = registry.newThreadFields.filter((f) => has(machine, `ext:${f.name}`))
  const fieldOptions = Object.fromEntries(fields.flatMap((f) => options[f.name] === undefined ? [] : [[f.name, options[f.name]!]]))
  const prompt = useRef<HTMLTextAreaElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const folderField = useRef<FolderFieldHandle>(null)

  /** Go to a field, as its key does: the folder with its list open. */
  const focus = (name: FieldName) => name === 'folder' ? folderField.current?.open()
    : body.current?.querySelector<HTMLElement>(`[data-field="${name}"] :is(input:not([type=file]), select, textarea, [role=combobox]):not(:disabled)`)?.focus()
  // It opens where it's still to be decided: the machine (where there's a choice), else the folder; asked for a
  // project (the sidebar's +), what to work on there. Under a finger none takes it (no keyboard over the dialog).
  const [first] = useState<FieldName | null>(() => !autoFocusOnOpen() ? null : asked.cwd ? 'prompt' : machines.length > 1 ? 'machine' : 'folder')

  // Each machine has its own models and default; what was picked on another doesn't carry over.
  useEffect(() => {
    setCatalog(undefined); setModel(null); setThinking(null)
    if (!machine) return
    let live = true
    client(machine.id).call('agent.models', {}).then((c) => {
      if (!live) return
      setCatalog(c)
      // On the machine it started on, the model and thinking it started with, where that machine has them.
      const from = machine.id === start.machine && [...c.models, ...(c.agents ?? []).flatMap((a) => a.models)].find((m) => m.value === start.model)
      if (from) { setModel(from.value); if (start.thinking && from.thinking.includes(start.thinking)) setThinking(start.thinking) }
    }, (e: Error) => {
      console.error(`Listing ${machine.id}'s models failed`, e)
      if (live) setCatalog({ message: e.message })
    })
    return () => { live = false }
  }, [machine?.id])

  // The profiles a thread in this folder could start with: at once, then as the folder is typed (a moment after the
  // last key).
  const profilesAsked = useRef(false)
  useEffect(() => {
    if (!machine) return
    let live = true
    const wait = profilesAsked.current ? 250 : 0
    profilesAsked.current = true
    const timer = setTimeout(() => {
      dispatch('profile.list', cwd.trim() ? { cwd: cwd.trim() } : {}, { machine: machine.id, source: 'new thread' })
        .then((list) => {
          if (!live) return
          const found = list as ProfileInfo[]
          setProfiles(found)
          // The profile it started with, while the folder is the one it started in (any, when it named none).
          setProfile(start.profile && start.profile !== 'default' && (start.cwd === undefined || cwd.trim() === start.cwd) && found.some((p) => p.name === start.profile) ? start.profile : null)
        }, (e: Error) => {
          console.error(`Listing the profiles for ${cwd || 'the home folder'} failed`, e)
          if (live) setProfiles({ message: e.message })
        })
    }, wait)
    return () => { live = false; clearTimeout(timer) }
  }, [machine?.id, cwd])
  const models = catalog && 'models' in catalog ? catalog : undefined
  const modelsFailed = catalog && !('models' in catalog) ? catalog : undefined
  /** The kind of agent a model is another's (Claude Agent's), with its group. */
  const agentOf = (value: string | null) => value ? models?.agents?.find((a) => a.models.some((m) => m.value === value)) : undefined
  // The machine's default may be another kind's model (Claude Code, picked in setup): with neither a model nor a profile
  // picked, the thread starts on it, with that kind's profile.
  const defaultKind = agentOf(models?.default.model ?? null)
  const agentModel = agentOf(model) ?? (model === null && profile === null ? defaultKind : undefined)
  const found = Array.isArray(profiles) ? profiles : undefined
  // The profile another kind's model starts with, listed before it's made (starting makes it).
  const profileList = found && agentModel && !found.some((p) => p.name === agentModel.profile)
    ? [...found, { name: agentModel.profile, scope: 'user' as const, dir: '', allowed: true, agent: agentModel.kind }]
    : found
  const profilesFailed = profiles && !Array.isArray(profiles) ? profiles : undefined
  const shownProfile = profile ?? agentModel?.profile ?? null
  const picked = profileList?.find((p) => p.name === (shownProfile ?? 'default'))
  /** The kind of agent the profile picked runs on, when it's another's: its models alone are offered. */
  const pickedKind = picked?.agent

  const chosen = agentModel ? agentModel.models.find((m) => m.value === (model ?? models?.default.model)) : pickedKind ? undefined : models?.models.find((m) => m.value === (model ?? models.default.model))
  const levels = chosen?.thinking ?? []
  const defaultModel = models && [...models.models, ...defaultKind?.models ?? []].find((m) => m.value === models.default.model)
  const defaultLabel = defaultModel && (pickedKind ? defaultKind?.kind === pickedKind : !defaultKind) ? `Default · ${defaultModel.label}` : 'Default'
  /** Pick a model; another kind's picks a profile of that kind, unless one is picked. */
  const pickModel = (value: string | null) => {
    setModel(value)
    setThinking(null)
    const kind = agentOf(value)
    if (kind && pickedKind !== kind.kind) setProfile(kind.profile)
  }
  /** Pick a profile; one on another kind than the model's leaves the model to it. */
  const pickProfile = (name: string | null) => {
    setProfile(name)
    const kind = profileList?.find((p) => p.name === (name ?? 'default'))?.agent
    if (model && agentOf(model)?.kind !== kind) { setModel(null); setThinking(null) }
  }

  const pickMachine = (id: string) => {
    setMachineId(id)
    setCwd(foldersOn(id)[0] ?? '')
  }

  const create = async ({ allow = false } = {}) => {
    if (!machine || busy) return
    // What the box holds now: a keypress straight after typing can come before the typing's render.
    const text = (prompt.current?.value ?? draft).trim()
    setBusy(true)
    setError(undefined)
    try {
      if (allow && picked) await dispatch('profile.allow', { ...(cwd.trim() ? { cwd: cwd.trim() } : {}), name: picked.name }, { machine: machine.id, source: 'new thread' })
      const created = await dispatch('thread.start', {
        ...(profile ? { profile } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}),
        ...(model ? { model } : {}), ...(thinking && levels.length ? { thinking } : {}),
        ...(text ? { prompt: text } : {}), ...(files.length ? { attachments: files } : {}),
        ...(Object.keys(fieldOptions).length ? { options: fieldOptions } : {}),
      }, { machine: machine.id, source: 'new thread' }) as ThreadInfo
      setLast({ machine: machine.id })
      setDraft('')
      onClose()
      select({ machine: machine.id, thread: created.id })
    } catch (e) {
      setError(e as Failure)
      setBusy(false)
    }
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const digit = ctrlDigit(event)
    const field = (Object.keys(KEYS) as FieldName[]).find((name) => KEYS[name] === digit)
    if (field) {
      // Its own, here: not the window's shortcut on the same keys (⌘1… is Ctrl+1… off macOS).
      event.preventDefault()
      event.stopPropagation()
      focus(field)
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
  }
  const browse = async () => {
    try {
      const chosen = await window.superego.call(APP, 'app.pickFolder', { defaultPath: cwd || undefined }) as string | null
      if (chosen) setCwd(chosen)
    } catch (e) {
      console.error('Picking a folder failed', e)
      setError({ message: `Couldn't pick a folder: ${(e as Error).message}` })
    }
  }

  return (
    // On a phone, Start at the bar's trailing edge, as iOS puts a sheet's confirming action, and no foot.
    // The prompt is kept as a draft however it's closed (`newThread.draft`); a name and attached files aren't, so with
    // either a phone's swipe asks before throwing them away.
    <Dialog onClose={onClose} title="New thread" size="medium" flush className="new-thread" unsaved={files.length > 0 || title.trim() !== ''}
      actions={narrow && <Button variant="primary" className="new-thread__start" disabled={!machine || busy} onClick={() => void create()}>Start</Button>}>
      <div ref={body} className="new-thread__body" onKeyDown={onKeyDown}>
        {!machine ? <p className="new-thread__note">No machine is connected.</p> : <>
          <div className="new-thread__where">
            <Field name="machine" label="Machine">
              <Select aria-label="Machine" autoFocus={first === 'machine'} options={machines.map((m) => ({ value: m.id, label: m.label }))} value={machine.id}
                onChange={(value) => { if (value) pickMachine(value) }} />
            </Field>
            <Field name="folder" label="Folder" className="new-thread__folder">
              <div className="new-thread__row">
                <FolderField ref={folderField} value={cwd} onChange={setCwd} folders={folders} problem={archivedProblem?.message} autoFocus={first === 'folder'} />
                {machine.id === 'local' && !window.superego.web && <Button onClick={() => void browse()}>Browse…</Button>}
              </div>
            </Field>
          </div>

          {fields.map(({ name, component: Extra }) => (
            <Contained key={name} name={name}><Extra machine={machine} cwd={cwd.trim()} value={options[name]}
              onChange={(value) => setOptions(({ [name]: _was, ...rest }) => value === undefined ? rest : { ...rest, [name]: value })} /></Contained>
          ))}

          <div className="new-thread__how">
            <Field name="profile" label="Profile">
              {profileList
                ? <ProfileSelect profiles={profileList} value={shownProfile} onChange={pickProfile} />
                : <Select aria-label="Profile" options={[]} value={null} nullLabel={profiles ? 'Unavailable' : 'Loading…'} disabled onChange={() => {}} />}
            </Field>
            <Field name="model" label="Model">
              <ModelPicker label="Model" catalog={models} value={model} nullLabel={defaultLabel} placeholder={catalog ? 'Unavailable' : 'Loading…'}
                agents={pickedKind ? { only: pickedKind } : 'all'} {...machine.id === 'local' ? {} : { where: `on ${machine.label}` }} onChange={pickModel}
                onStar={(next) => {
                  if (!machine || !models) return
                  setCatalog(withFavourites(models, next))
                  void dispatch('settings.set', { key: 'agent.favourites', value: next }, { machine: machine.id, source: 'new thread' })
                    .then(() => client(machine.id).call('agent.models', {}))
                    .then(setCatalog, (e: Error) => { console.error('Starring a model failed', e); setCatalog(models); setError({ message: `Couldn't star it: ${e.message}` }) })
                }} />
            </Field>
            <Field name="thinking" label="Thinking">
              <Select aria-label="Thinking" options={levels.map((l) => ({ value: l, label: l }))} value={thinking} disabled={!levels.length}
                nullLabel={!models ? (catalog ? 'Unavailable' : 'Loading…') : !levels.length ? 'Not offered' : models.default.thinking && !agentModel ? `Default · ${models.default.thinking}` : 'Default'} onChange={setThinking} />
            </Field>
          </div>
          {profilesFailed && <p className="new-thread__problem">Couldn't list the profiles here: {profilesFailed.message}</p>}
          {modelsFailed && <p className="new-thread__problem">Couldn't list {machine.label}'s models: {modelsFailed.message}</p>}

          <div className="new-thread__field" data-field="prompt">
            <span className="new-thread__label" onClick={() => focus('prompt')}>Prompt<kbd>{keyLabel(`ctrl+${KEYS.prompt}`)}</kbd></span>
            <ComposerBox className="new-thread__composer" where={{ machine, cwd: cwd.trim() }} text={draft} setText={setDraft} files={files} setFiles={setFiles}
              inputRef={prompt} aria-label="Prompt" autoFocus={first === 'prompt'} placeholder="What should it work on? (optional)" disabled={busy}
              onError={(message) => setError({ message })}
              onKeyDown={(event) => {
                // ⏎ starts it, as the composer sends; with nothing to send, only ⌘⏎ (or Start) does.
                if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                  event.preventDefault()
                  if (event.currentTarget.value.trim() || files.length) void create()
                }
              }} />
          </div>

          <Field name="name" label="Name">
            <TextField aria-label="Name" placeholder="From the prompt (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </>}
        {picked && !picked.allowed && !error && (
          <p className="new-thread__note">The {picked.name} profile runs this project's own code. Starting will ask to allow it.</p>
        )}
        {error && (
          <div className="new-thread__error" role="alert">
            {error.kind === 'no_model' && machine ? <NoModel machine={machine} before={onClose} />
              : error.kind === 'model_unavailable' && machine ? <NoModel machine={machine} before={onClose} said={error.message} />
              : <p>{error.message}</p>}
            {error.kind === 'profile_not_allowed' && <Button onClick={() => void create({ allow: true })}>Allow and start</Button>}
          </div>
        )}
      </div>
      {!narrow && (
        <footer className="new-thread__foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!machine || busy} onClick={() => void create()}>Start <kbd>{keyLabel('mod+enter')}</kbd></Button>
        </footer>
      )}
    </Dialog>
  )
}

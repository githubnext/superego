// Settings → MCP servers: a machine's servers, a row each (its state and sign-in, what it runs, Use in threads without a
// profile, and a menu: Edit, Restart, Show log, Client secret, Sign out, Remove), Sign in or Set key where it needs them, Allow for a command
// someone else added, and Add server. Then From profiles: the servers of profiles seen here, to sign in to, not to edit.
// Everything goes through the extension's actions on that machine (`target`), so a remote one works the same.
import { useEffect, useState, type ReactNode } from 'react'
import { SignInFlow, useDispatch, useValue, type SettingsComponentProps } from '@superego/app/ui'
import { Button, CaretRightIcon, Dialog, DotsThreeIcon, IconButton, Menu, SegmentedControl, Select, Switch, TextField } from '@superego/ui'
import { CATALOG } from './catalog.ts'
import { authMenu, checkText, commandLine, configOf, DOT, emptyForm, formOf, nameFrom, needs, secretLabel, secretPlaceholder, signInDetails, signInText, splitCommandLine, stateText, type ServerForm } from './describe.ts'
import { ACTIONS, type CheckResult, type LogResult, type SectionData, type ServerInfo, SERVERS_VALUE } from './shared.ts'

type Act = (id: string, params: Record<string, unknown>) => Promise<unknown>

/** Run the extension's actions on `machine`, from Settings. */
function useAct(machine: string): Act {
  const dispatch = useDispatch()
  return (id, params) => dispatch(id, params as never, { machine, source: 'settings' })
}

export function ServersSection({ target, section }: SettingsComponentProps) {
  const live = useValue<SectionData>(target, true, SERVERS_VALUE)
  const data = live ?? section.data as SectionData | undefined
  const act = useAct(target)
  const [editing, setEditing] = useState<ServerInfo | 'new'>()
  const [log, setLog] = useState<ServerInfo>()
  // A sign-in going on under a row, or its secrets' fields open (`secrets`: an OAuth server's): each drawn afresh (`n`).
  const [helping, setHelping] = useState<{ id: string; n: number; secrets?: boolean }>()
  const [error, setError] = useState<string>()
  const run = (id: string, params: Record<string, unknown>) => { setError(undefined); void act(id, params).catch((e: Error) => setError(e.message)) }
  const help = (server: ServerInfo, secrets?: boolean) => setHelping((was) => ({ id: server.id, n: (was?.n ?? 0) + 1, ...(secrets ? { secrets } : {}) }))
  if (!data) return null
  const row = (server: ServerInfo, own: boolean) => (
    <ServerRow key={server.id} server={server} own={own} run={run} onEdit={() => setEditing(server)} onLog={() => setLog(server)} onHelp={(secrets) => help(server, secrets)}>
      {helping?.id === server.id && <SignIn key={helping.n} machine={target} server={server} secrets={helping.secrets} onClose={() => setHelping(undefined)} />}
    </ServerRow>
  )
  return (
    <div className="mcp-servers">
      {data.servers.length > 0 && <div className="mcp-servers__head" aria-hidden>Without a profile</div>}
      {data.servers.map((server) => row(server, true))}
      <div className="mcp-servers__add"><Button onClick={() => setEditing('new')}>Add server…</Button></div>
      {error && <p className="setting__error">{error}</p>}
      {data.profiles.length > 0 && (
        <>
          <h3 className="mcp-servers__group">From profiles</h3>
          {data.profiles.map((server) => row(server, false))}
        </>
      )}
      {editing && (
        <ServerDialog machine={target} editing={editing === 'new' ? undefined : editing} taken={data.servers.map((s) => s.name)}
          onClose={() => setEditing(undefined)} onSignIn={(server) => { setEditing(undefined); help(server) }} />
      )}
      {log && <LogDialog machine={target} server={log} onClose={() => setLog(undefined)} />}
    </div>
  )
}

/** One server: name and title, what it runs, its state; what it needs of the user; its switch and menu. */
export function ServerRow({ server, own, run, onEdit, onLog, onHelp, children }: {
  server: ServerInfo
  /** The machine's own (editable), not a profile's. */
  own: boolean
  run(id: string, params: Record<string, unknown>): void
  onEdit(): void
  onLog(): void
  /** Sign in or Set key; `secrets`: an OAuth server's client secret. */
  onHelp(secrets?: boolean): void
  children?: ReactNode
}) {
  const { name, config, state } = server
  const how = needs(server)
  const menu = authMenu(server)
  const signedIn = signInText(server.oauth)
  const from = server.from.type === 'profile' ? server.from : undefined
  return (
    <div className={`mcp-server is-${state}`}>
      <div className="mcp-server__main">
        <div className="setting__label">
          <div className="mcp-server__name">
            <span className={`superego-status superego-status--${DOT[state]}`} aria-hidden />
            <span>{name}</span>
            {config.title && config.title.toLowerCase() !== name && <span className="mcp-server__title">{config.title}</span>}
          </div>
          <div className="settings__note mcp-server__runs">
            <code title={config.command ? commandLine(config) : config.url}>{server.runs}</code> · {stateText(server)}
            {signedIn && <> · <span title={signInDetails(server.oauth)}>{signedIn}</span></>}
            {from && <> · profile <b>{from.profile}</b>{from.scope === 'project' ? ` in ${from.project.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')}` : ''}</>}
          </div>
          {/* Why it failed, or the last error of one that runs: what the state and the buttons don't say already. */}
          {server.error && (state === 'failed' || state === 'running' || state === 'stopped' || state === 'starting') && <div className="setting__error">{server.error}</div>}
          {server.skipped?.length ? <div className="settings__note">Skipped: {server.skipped.map((s) => `${s.tool} (${s.why})`).join(', ')}</div> : null}
        </div>
        <div className="provider__actions">
          {how === 'sign-in' && <Button variant="primary" onClick={() => onHelp()}>Sign in</Button>}
          {how === 'key' && <Button variant="primary" onClick={() => onHelp()}>Set key</Button>}
          {state === 'failed' && <Button onClick={onLog}>Show log</Button>}
          {own && (
            <span className="mcp-server__unprofiled" title="Use in threads without a profile">
              <Switch label="Use in threads without a profile" checked={config.unprofiled === true} onChange={(on) => run(ACTIONS.set, { name, unprofiled: on })} />
            </span>
          )}
          <Menu.Root>
            <Menu.Trigger render={<IconButton label={`${name}: more`} className="mcp-server__more" />}><DotsThreeIcon size={16} weight="bold" aria-hidden /></Menu.Trigger>
            <Menu.Popup>
              {own && <Menu.Item onClick={onEdit}>Edit…</Menu.Item>}
              {own && <Menu.Item onClick={() => run(ACTIONS.set, { name, enabled: config.enabled === false })}>{config.enabled === false ? 'Switch on' : 'Switch off'}</Menu.Item>}
              <Menu.Item disabled={state === 'off' || state === 'waiting'} onClick={() => run(ACTIONS.restart, { server: server.id })}>Restart</Menu.Item>
              <Menu.Item onClick={onLog}>Show log</Menu.Item>
              {menu.help && <Menu.Item onClick={() => onHelp()}>{menu.help}</Menu.Item>}
              {menu.clientSecret && <Menu.Item onClick={() => onHelp(true)}>Client secret…</Menu.Item>}
              {menu.signOut && <Menu.Item onClick={() => run(ACTIONS.logout, { server: server.id })}>Sign out</Menu.Item>}
              {own && <><Menu.Separator /><Menu.Item onClick={() => run(ACTIONS.remove, { name })}>Remove</Menu.Item></>}
            </Menu.Popup>
          </Menu.Root>
        </div>
      </div>
      {/* A command someone other than you added (Ego): all of what it runs, to allow or not. */}
      {state === 'waiting' && (
        <div className="mcp-server__allow">
          <div className="settings__note">Added by Ego. It runs this command on this machine once you allow it:</div>
          <pre className="mcp-server__line">{commandLine(config)}</pre>
          <div className="mcp-server__allow-actions">
            <Button variant="primary" onClick={() => run(ACTIONS.allow, { name })}>Allow</Button>
            <Button onClick={() => run(ACTIONS.remove, { name })}>Remove</Button>
          </div>
        </div>
      )}
      {children}
    </div>
  )
}

/**
 * Signing in to a server: its OAuth flow (`mcp-servers.login`), or its secrets' fields (a key, secret env values, or an
 * OAuth client's secret: `secrets`).
 */
export function SignIn({ machine, server, secrets, onClose }: { machine: string; server: ServerInfo; secrets?: boolean; onClose(): void }) {
  const act = useAct(machine)
  const name = server.config.title ?? server.name
  if (server.config.auth?.type === 'oauth' && !secrets) {
    return <SignInFlow machine={machine} title={`Signing in to ${name}`} start={() => act(ACTIONS.login, { server: server.id }) as Promise<{ flow: string }>} onClose={onClose} />
  }
  return <Secrets machine={machine} server={server} onClose={onClose} />
}

/** The secrets a server takes, each a field: typed values are set, blank ones left as they are. */
function Secrets({ machine, server, onClose }: { machine: string; server: ServerInfo; onClose(): void }) {
  const act = useAct(machine)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; text: string }>()
  if (!server.secrets.length) return null
  return (
    <form className="auth-flow mcp-secrets" onSubmit={(e) => {
      e.preventDefault()
      const form = new FormData(e.currentTarget)
      const values = Object.fromEntries(server.secrets.flatMap((s) => { const v = form.get(s.name); return typeof v === 'string' && v ? [[s.name, v]] : [] }))
      if (!Object.keys(values).length) return onClose()
      setBusy(true)
      setSaid(undefined)
      act(ACTIONS.setSecret, { server: server.id, values })
        .then((result) => { const check = checkText((result as CheckResult).server); setSaid(check); if (check.ok && check.text.startsWith('Connected')) onClose() },
          (error: Error) => setSaid({ ok: false, text: error.message }))
        .finally(() => setBusy(false))
    }}>
      {server.secrets.map((secret, index) => (
        <label key={secret.name} className="mcp-secrets__field">
          <span>{secretLabel(secret.name) ?? <code>{secret.name}</code>}</span>
          <TextField name={secret.name} type="password" autoFocus={index === 0} autoComplete="off" placeholder={secretPlaceholder(secret)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }} />
        </label>
      ))}
      {said && <p className={said.ok ? 'settings__note' : 'setting__error'}>{said.text}</p>}
      <div className="mcp-secrets__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Checking…' : 'Save'}</Button>
        <Button onClick={onClose}>{said ? 'Close' : 'Cancel'}</Button>
      </div>
    </form>
  )
}

/** Signing in from outside Settings (the notice over a thread's composer): the same, in a dialog. */
export function SignInDialog({ machine, server, onClose }: { machine: string; server: ServerInfo; onClose(): void }) {
  return (
    <Dialog title={server.config.title ?? server.name} size="small" onClose={onClose} className="mcp-sign-in">
      <SignIn machine={machine} server={server} onClose={onClose} />
    </Dialog>
  )
}

/** Add server, or Edit: the form, then the check its saving starts ("Connected · 23 tools", or why not). */
function ServerDialog({ machine, editing, taken, onClose, onSignIn }: {
  machine: string; editing?: ServerInfo; taken: string[]; onClose(): void; onSignIn(server: ServerInfo): void
}) {
  const act = useAct(machine)
  const [form, setForm] = useState<ServerForm>(() => editing ? formOf(editing.name, editing.config) : emptyForm())
  // Whether the name is the user's own, not one filled in from the URL or package.
  const [named, setNamed] = useState(Boolean(editing))
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [checked, setChecked] = useState<ServerInfo>()
  const change = (patch: Partial<ServerForm>) => setForm((was) => {
    const next = { ...was, ...patch }
    if (named) return next
    const words = splitCommandLine(next.line)
    const guess = nameFrom(next.kind === 'url' ? { url: next.url } : { ...(words[0] ? { command: words[0] } : {}), args: words.slice(1) })
    return { ...next, name: guess && taken.includes(guess) ? `${guess}-2` : guess ?? '' }
  })
  // The well-known server it was filled from, for what to do after.
  const [picked, setPicked] = useState<string>()
  const fill = (name: string | null) => {
    const entry = CATALOG.find((e) => e.name === name)
    if (!entry) return
    setForm({ ...formOf(entry.name, entry.server), name: taken.includes(entry.name) ? `${entry.name}-2` : entry.name })
    setNamed(true)
    setPicked(entry.name)
  }
  const save = async () => {
    setError(undefined)
    setChecked(undefined)
    let saved
    try { saved = configOf(form, editing?.config) } catch (e) { return setError((e as Error).message) }
    setBusy(true)
    try {
      const { name, config, secrets } = saved
      let result = await act(editing ? ACTIONS.edit : ACTIONS.add, editing
        ? { name: editing.name, server: config, ...(name !== editing.name ? { rename: name } : {}) }
        : { name, server: config }) as CheckResult
      if (Object.keys(secrets).length) result = await act(ACTIONS.setSecret, { server: name, values: secrets }) as CheckResult
      setChecked(result.server)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const check = checked && checkText(checked)
  const entry = CATALOG.find((e) => e.name === picked)
  return (
    <Dialog title={editing ? `Edit ${editing.name}` : 'Add an MCP server'} size="medium" onClose={onClose} className="mcp-dialog">
      <form className="mcp-dialog__form" onSubmit={(e) => { e.preventDefault(); if (!busy) void save() }}>
        {!editing && (
          <Select aria-label="A well-known server" value={picked ?? null} nullLabel="A well-known server…" onChange={fill}
            options={CATALOG.map((e) => ({ value: e.name, label: `${e.title}: ${e.description}` }))} />
        )}
        <SegmentedControl label="Runs" value={form.kind} onChange={(kind) => change({ kind })}
          options={[{ value: 'command', label: 'Command' }, { value: 'url', label: 'URL' }]} />
        {form.kind === 'command' ? (
          <TextField aria-label="Command" autoFocus={!editing} placeholder="npx -y @sentry/mcp-server" value={form.line} spellCheck={false} onChange={(e) => change({ line: e.target.value })} />
        ) : (
          <TextField aria-label="URL" autoFocus={!editing} placeholder="https://mcp.linear.app/mcp" value={form.url} spellCheck={false} onChange={(e) => change({ url: e.target.value })} />
        )}
        <div className="mcp-dialog__pair">
          <label><span>Name</span><TextField value={form.name} spellCheck={false} onChange={(e) => { setNamed(true); setForm({ ...form, name: e.target.value }) }} /></label>
          <label><span>Title</span><TextField value={form.title} placeholder="Optional" onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        </div>
        {form.kind === 'command' ? <EnvRows form={form} setForm={setForm} secretsSet={editing?.secrets ?? []} /> : (
          <div className="mcp-dialog__pair">
            <label><span>Sign-in</span>
              <Select value={form.auth} onChange={(auth) => setForm({ ...form, auth: (auth ?? 'none') as ServerForm['auth'] })}
                options={[{ value: 'none', label: 'None' }, { value: 'oauth', label: 'OAuth (in the browser)' }, { value: 'api-key', label: 'API key' }]} />
            </label>
            {form.auth === 'api-key' && (
              <label><span>API key</span><TextField type="password" autoComplete="off" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder={editing?.secrets.find((s) => s.name === 'key')?.set ? 'Set (type to replace)' : ''} /></label>
            )}
          </div>
        )}
        <details className="mcp-dialog__more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
          <summary><CaretRightIcon className="mcp-call__caret" size={10} aria-hidden /> More</summary>
          <div className="mcp-dialog__pair">
            <label><span>Runs for</span>
              <Select value={form.lifetime} onChange={(lifetime) => setForm({ ...form, lifetime: (lifetime ?? 'machine') as ServerForm['lifetime'] })}
                options={[{ value: 'machine', label: 'All threads (one, shared)' }, { value: 'thread', label: 'Each thread (its own, in its folder)' }]} />
            </label>
            <label><span>Tools</span>
              <Select value={form.tools} onChange={(tools) => setForm({ ...form, tools: (tools ?? 'auto') as ServerForm['tools'] })}
                options={[{ value: 'auto', label: 'Offered, or found by search when many' }, { value: 'all', label: 'Always offered' }, { value: 'search', label: 'Found by search' }]} />
            </label>
          </div>
          <label className="mcp-dialog__timeout"><span>Timeout per call (seconds)</span><TextField inputMode="numeric" placeholder="300" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })} /></label>
        </details>
        {entry?.setup && <p className="settings__note">{entry.setup}</p>}
        {error && <p className="setting__error">{error}</p>}
        {check && <p className={`mcp-dialog__check ${check.ok ? '' : 'setting__error'}`}>{check.text}</p>}
        <div className="mcp-dialog__actions">
          {checked && checked.state !== 'failed' ? (
            <>
              {needs(checked) && <Button variant="primary" onClick={() => onSignIn(checked)}>{needs(checked) === 'sign-in' ? 'Sign in' : 'Set key'}</Button>}
              <Button variant={needs(checked) ? 'default' : 'primary'} onClick={onClose}>Done</Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Checking…' : editing ? 'Save' : 'Add'}</Button>
            </>
          )}
        </div>
      </form>
    </Dialog>
  )
}

/** A command's environment: plain values (kept in the config) and secret ones (kept in the store, never shown). */
function EnvRows({ form, setForm, secretsSet }: { form: ServerForm; setForm(form: ServerForm): void; secretsSet: ServerInfo['secrets'] }) {
  const set = (index: number, patch: Partial<ServerForm['env'][number]>) => setForm({ ...form, env: form.env.map((row, i) => i === index ? { ...row, ...patch } : row) })
  return (
    <div className="mcp-env">
      {form.env.length > 0 && <div className="mcp-dialog__label">Environment</div>}
      {form.env.map((row, index) => (
        <div key={index} className="mcp-env__row">
          <TextField aria-label="Variable" placeholder="NAME" value={row.name} spellCheck={false} onChange={(e) => set(index, { name: e.target.value })} />
          <TextField aria-label="Value" type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} spellCheck={false}
            placeholder={row.secret && secretsSet.find((s) => s.name === row.name)?.set ? 'Set (type to replace)' : 'value'} onChange={(e) => set(index, { value: e.target.value })} />
          <label className="mcp-env__secret"><input type="checkbox" checked={row.secret} onChange={(e) => set(index, { secret: e.target.checked })} /> Secret</label>
          <IconButton label="Remove" onClick={() => setForm({ ...form, env: form.env.filter((_, i) => i !== index) })}>✕</IconButton>
        </div>
      ))}
      <Button onClick={() => setForm({ ...form, env: [...form.env, { name: '', value: '', secret: false }] })}>Add environment variable</Button>
    </div>
  )
}

/** A server's log: the last lines, secrets as `***`. */
function LogDialog({ machine, server, onClose }: { machine: string; server: ServerInfo; onClose(): void }) {
  const act = useAct(machine)
  const [log, setLog] = useState<LogResult | { error: string }>()
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    let live = true
    act(ACTIONS.log, { server: server.id, lines: 400 }).then((result) => { if (live) setLog(result as LogResult) }, (error: Error) => { if (live) setLog({ error: error.message }) })
    return () => { live = false }
  }, [asked])
  return (
    <Dialog title={`${server.name}: log`} size="large" onClose={onClose} className="mcp-log"
      actions={<Button onClick={() => setAsked((n) => n + 1)}>Refresh</Button>}>
      {!log ? <p className="settings__note">Loading…</p>
        : 'error' in log ? <p className="setting__error">{log.error}</p>
        : <>
          <p className="settings__note"><code>{log.path}</code></p>
          <pre className="mcp-log__text">{log.text || 'Nothing logged yet.'}</pre>
        </>}
    </Dialog>
  )
}

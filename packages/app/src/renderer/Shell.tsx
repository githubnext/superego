// The shell every app gets: the sidebar slot (or, with nothing there, a compact session picker), the selected session,
// the restart notice, Settings, and the app-wide reactions (fonts, ⌘, , sessions shown from the command line or a
// notification, marking finished sessions seen).
import { useEffect, useState } from 'react'
import { Button, Select } from '@mu/ui'
import { machine as client, useSettings } from './client.ts'
import { Slot, useRegistry } from './extension.tsx'
import { ServiceNotice } from './ServiceNotice.tsx'
import { SessionView } from './SessionView.tsx'
import { SettingsView } from './SettingsView.tsx'
import { Palette } from './Palette.tsx'
import { useAllSessions, useMachines, useSelection, useSettingsDialog, useShell, type Selection } from './state.tsx'

export function Shell() {
  const registry = useRegistry()
  const [palette, setPalette] = useState(false)
  const machines = useMachines()
  const { selection, select, machine, session } = useSelection()
  const settings = useSettingsDialog()
  const { openSettings } = useShell()
  const hasSidebar = registry.slots.sidebar.length > 0
  useAppEffects(() => setPalette((open) => !open))

  // Looking at a finished or failed session marks it seen.
  useEffect(() => {
    if (!selection || !session || (session.status.state !== 'done' && session.status.state !== 'error') || !document.hasFocus()) return
    void client(selection.machine).call('session.seen', { id: selection.session }).catch(() => {})
  }, [selection?.machine, selection?.session, session?.status.state])

  const actions = <><ServiceNotice /><Button variant="ghost" onClick={openSettings}>Settings</Button></>
  return (
    <div className={`app ${hasSidebar ? 'has-sidebar' : ''}`}>
      {hasSidebar && (
        <aside className="app__sidebar">
          <div className="app__drag" />
          <Slot name="sidebar" props={{}} />
          <div className="app__footer">{actions}</div>
        </aside>
      )}
      <main className="app__main">
        <div className="app__drag">{!hasSidebar && <div className="app__bar"><SessionPicker />{actions}</div>}</div>
        {selection && session && machine
          ? <SessionView key={`${selection.machine}/${selection.session}`} machine={machine} session={session} />
          : <div className="app__empty">{hasSidebar ? 'Select or start a session.' : `Start a session with: ${registry.app.id}`}</div>}
      </main>
      {selection && session && machine && registry.slots['session.aside'].length > 0 && (
        <aside className="app__aside"><div className="app__drag" /><Slot name="session.aside" props={{ machine, session }} /></aside>
      )}
      {settings.open && <SettingsView machines={machines} onClose={settings.close} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  )
}

/** Without a sidebar: every machine's sessions in one menu, and a new session on this computer. */
function SessionPicker() {
  const machines = useMachines().filter((m) => m.state !== 'disabled')
  const { selection, select } = useSelection()
  const sessions = useAllSessions()
  const options = machines.flatMap((m) => (sessions[m.id] ?? []).map((s) => ({
    value: `${m.id}/${s.id}`, label: s.title, ...(machines.length > 1 ? { group: m.label } : {}),
  })))
  const start = async () => {
    const created = await client('local').call('session.create', {})
    select({ machine: 'local', session: created.id })
  }
  return (
    <div className="session-picker">
      <Select aria-label="Session" options={options} value={selection ? `${selection.machine}/${selection.session}` : null}
        nullLabel={options.length ? 'Sessions' : 'No sessions yet'}
        onChange={(value) => {
          if (!value) return
          const slash = value.indexOf('/')
          select({ machine: value.slice(0, slash), session: value.slice(slash + 1) })
        }} />
      <Button variant="ghost" onClick={() => void start()}>New</Button>
    </div>
  )
}

/** Fonts from the app's settings; ⌘, ; sessions and Settings shown from the command line, a notification or the menu bar. */
function useAppEffects(togglePalette: () => void) {
  const appSettings = useSettings('app', true)
  const { select } = useSelection()
  const { openSettings } = useShell()
  const interfaceFont = appSettings?.values['app.font.interface']
  const monoFont = appSettings?.values['app.font.mono']
  const registry = useRegistry()
  useEffect(() => {
    const style = document.documentElement.style
    const set = (variable: string, family: unknown) => typeof family === 'string' ? style.setProperty(variable, `"${family.replace(/"/g, '')}", var(${variable}-fallback)`) : style.removeProperty(variable)
    set('--mu-font', interfaceFont)
    set('--mu-mono', monoFont)
  }, [interfaceFont, monoFont])
  useEffect(() => {
    document.title = registry.app.name
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); togglePalette() }
      for (const command of registry.commands) if (command.keys && matches(event, command.keys)) { event.preventDefault(); command.run() }
    }
    window.addEventListener('keydown', onKey)
    const show = ({ open, settings }: { open?: Selection; settings?: boolean }) => {
      if (open) select(open)
      if (settings) openSettings()
    }
    const off = window.mu.onEvent((event) => {
      if (event.machine !== 'app') return
      if (event.method === 'app.select') show({ open: event.params as Selection })
      if (event.method === 'app.settings') show({ settings: true })
    })
    void (window.mu.call('app', 'app.ready', {}) as Promise<{ open?: Selection; settings?: boolean }>).then(show)
    return () => { window.removeEventListener('keydown', onKey); off() }
  }, [])
}

/** Whether `event` is the shortcut `keys`, like `mod+shift+n`; `mod` is ⌘ on macOS and Ctrl elsewhere. */
function matches(event: KeyboardEvent, keys: string) {
  const parts = keys.toLowerCase().split('+')
  const key = parts.pop()
  const mac = navigator.platform.startsWith('Mac')
  const want = { meta: parts.includes('meta') || (mac && parts.includes('mod')), ctrl: parts.includes('ctrl') || (!mac && parts.includes('mod')), shift: parts.includes('shift'), alt: parts.includes('alt') }
  return event.key.toLowerCase() === key && event.metaKey === want.meta && event.ctrlKey === want.ctrl && event.shiftKey === want.shift && event.altKey === want.alt
}

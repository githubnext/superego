// Settings, drawn generically from what each endpoint registers: the app's own settings (on its three tabs, see
// settings/tabs.ts) and every machine's. Sections may name a custom component (`ui`) drawn below their settings; the
// Providers section is one.
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { Json, SectionInfo, SettingsSnapshot } from '@superego/protocol'
import { BaseUI, CaretRightIcon, Dialog, Glyph } from '@superego/ui'
import { ACCENT, APP } from '../shared/app-settings.ts'
import type { MachineEntry } from '../shared/bridge.ts'
import { THEME_WINDOW } from '../shared/themes.ts'
import { useSettings, useValue } from './client.ts'
import { Contained } from './contained.tsx'
import { useRegistry } from './registry.tsx'
import { settingsEntry } from './lookups.ts'
import { useNarrow } from './media.ts'
import { Setting } from './settings/controls.tsx'
import { AllMachines, machineGlyph, Machines } from './settings/machines.tsx'
import { ALL, APP_TABS, appTab, appTarget, MACHINES, openTarget, sectionTab } from './settings/tabs.ts'
import { useSettingsDialog, useSettingsTarget } from './state.tsx'
import { ThemeTools, useChosenThemes } from './themes.tsx'

/**
 * Settings: wide, a pane beside the rail (Escape goes back); in a small window, a dialog, its tabs across the top; on a
 * phone, as iOS's Settings: a list of its tabs, each opening its page in the sheet, ‹ Settings going back.
 */
export function SettingsView({ machines, onClose, pane = false }: { machines: MachineEntry[]; onClose(): void; pane?: boolean }) {
  const [kept, setTarget] = useSettingsTarget()
  const target = openTarget(kept, machines)
  const tab = appTab(target)
  const machine = machines.find((m) => m.id === target)
  const endpoint = tab ? APP : target
  const connected = Boolean(tab) || machine?.state === 'connected'
  const snapshot = useSettings(endpoint, target !== MACHINES && target !== ALL && connected)
  const editable = machines.filter((m) => m.state === 'connected')
  useEffect(() => {
    if (!pane) return
    // Escape that something in it took (a picker closing, a field) stays there.
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane, onClose])
  // An app tab shows the app's sections under it; a machine's, all of its own. A section shows when it has something
  // to: a setting not hidden, or a component of its own.
  const sections = snapshot?.sections
    .filter((section) => !tab || sectionTab(section) === tab)
    .filter((section) => section.ui || section.settings.some((s) => !s.hidden))
  const tabTitle = APP_TABS.find((t) => t.tab === tab)?.title

  const content = target === MACHINES ? <Machines machines={machines} onOpen={setTarget} />
    : target === ALL ? <AllMachines machines={editable} />
    : !connected ? <p className="settings__note">{machine?.label} is {machine?.state}. Its settings live on it, so they show once it is back.</p>
    : !sections ? <p className="settings__note">Loading…</p>
    : sections.map((section) => (
      // Its heading goes where the tab already says it (Appearance under Appearance).
      <Section key={section.id} machine={machine} target={endpoint} section={section} values={snapshot!.values} heading={section.title !== tabTitle} />
    ))

  // On a phone: the list, or a tab's page (opened there when Settings was asked for at one).
  const narrow = useNarrow()
  const { atTab } = useSettingsDialog()
  const [paged, setPaged] = useState(atTab)
  if (narrow && !pane) {
    const open = (to: string) => { setTarget(to); setPaged(true) }
    const row = (to: string, label: ReactNode) => (
      <button key={to} type="button" className="settings__row" onClick={() => open(to)}>
        <span className="settings__row-label">{label}</span><CaretRightIcon size={14} weight="bold" aria-hidden />
      </button>
    )
    const title = tabTitle ?? (target === MACHINES ? 'Machines' : target === ALL ? 'All machines' : machine?.label ?? 'Settings')
    return (
      <Dialog title={paged ? title : 'Settings'} size="large" onClose={onClose} className="settings settings--list"
        {...(paged ? { back: { label: 'Settings', onBack: () => setPaged(false) } } : {})}>
        {paged
          ? <div key={target} className="settings__content">{content}</div>
          : (
            <nav className="settings__groups" aria-label="Settings">
              <div className="settings__group">{APP_TABS.map((t) => row(appTarget(t.tab), t.title))}</div>
              <div className="settings__group">
                {row(MACHINES, 'Machines')}
                {editable.length > 1 && row(ALL, 'All machines')}
                {machines.filter((m) => m.state !== 'disabled').map((m) => row(m.id, <><Glyph shape={machineGlyph(m.state)} /> {m.label}</>))}
              </div>
            </nav>
          )}
      </Dialog>
    )
  }
  // Down the side in the window; across the top in a dialog (app.css), where the arrow keys follow. A panel of its own
  // for each tab (keyed), so one opens at its top, not scrolled as the last was.
  const body = (
    <BaseUI.Tabs.Root className="settings__body" orientation={pane ? 'vertical' : 'horizontal'} value={target} onValueChange={(value: string) => setTarget(value)}>
      <BaseUI.Tabs.List className="settings__nav" render={<nav />}>
        {APP_TABS.map((t) => <BaseUI.Tabs.Tab key={t.tab} value={appTarget(t.tab)}>{t.title}</BaseUI.Tabs.Tab>)}
        <BaseUI.Tabs.Tab value={MACHINES}>Machines</BaseUI.Tabs.Tab>
        {editable.length > 1 && <BaseUI.Tabs.Tab value={ALL}>All machines</BaseUI.Tabs.Tab>}
        {machines.filter((m) => m.state !== 'disabled').map((m) => (
          <BaseUI.Tabs.Tab key={m.id} value={m.id} className="settings__nav-machine">
            <Glyph shape={machineGlyph(m.state)} /> {m.label}
          </BaseUI.Tabs.Tab>
        ))}
      </BaseUI.Tabs.List>
      <BaseUI.Tabs.Panel key={target} value={target} className="settings__content">{content}</BaseUI.Tabs.Panel>
    </BaseUI.Tabs.Root>
  )
  return pane
    ? <section className="settings settings--pane" aria-label="Settings">{body}</section>
    : <Dialog title="Settings" size="large" onClose={onClose} className="settings">{body}</Dialog>
}

function Section({ machine, target, section, values, heading }: { machine: MachineEntry | undefined; target: string; section: SectionInfo; values: SettingsSnapshot['values']; heading: boolean }) {
  const registry = useRegistry()
  const dispatch = registry.router.dispatch
  const custom = section.ui ? settingsEntry(registry, section.ui, target) : undefined
  const Custom = custom?.component
  // Drawn from a live value: that's its data, kept current.
  const live = useValue<Json>(section.value ? machine : undefined, section.value ?? '')
  const shown = section.settings.filter((s) => !s.hidden)
  const { accentThemed } = useChosenThemes()
  return (
    <section className="settings-section">
      {heading && <h2>{section.title}</h2>}
      {section.description && <p className="settings__note">{section.description}</p>}
      {shown.map((setting) => (
        <Fragment key={setting.key}>
          <Setting setting={setting} value={values[setting.key] ?? null} note={target === APP && setting.key === ACCENT && accentThemed ? 'The theme’s, until you choose one.' : undefined}
            apply={(value) => dispatch(setting.type === 'secret' ? 'secrets.set' : target === APP ? 'app.settings.set' : 'settings.set', { key: setting.key, value }, { machine: target, source: 'settings' })} />
          {/* Under the theme pickers and their switch: both themes as they look, and importing. */}
          {setting.key === THEME_WINDOW && <ThemeTools />}
        </Fragment>
      ))}
      {Custom && <Contained name={section.ui!} scope={custom!.owner.profile}><Custom target={target} section={section.value ? { ...section, ...(live != null ? { data: live } : {}) } : section} /></Contained>}
    </section>
  )
}

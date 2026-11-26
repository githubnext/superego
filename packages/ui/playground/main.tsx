// The @superego/ui playground: every component the package has, live, in the window's tokens, with the controls that
// change how they're drawn (light or dark, a theme, the accent, the text size) and a phone's width beside a desktop's.
// For iterating on the components themselves: `pnpm ui:playground`. Its state is in the address (`?scheme=dark&open=
// confirm-delete`), so a view can be linked to, reloaded, or screenshotted as it is.
import { StrictMode, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Status } from '@superego/protocol'
import '../src/styles.css'
import './playground.css'
import {
  ArchiveIcon, Button, ColourSwatches, ConfirmDialog, ContextMenu, CopyIcon, DeviceMobileIcon, Dialog, FileTextIcon, FolderSimpleIcon,
  FontPicker, GearSixIcon, Glyph, GitBranchIcon, HoverCard, IconButton, LaptopIcon, List, ListItem, MachineName, MagnifyingGlassIcon, Menu,
  Panel, PencilSimpleIcon, PlusIcon, Popover, PromptDialog, ProviderMark, SegmentedControl, Select, Slider, SparkleIcon, StatusGlyph, StatusWord,
  Switch, TerminalIcon, TextArea, TextField, Tooltip, TooltipProvider, XIcon, type GlyphShape,
} from '../src/index.ts'
import { BUILTIN_THEMES, DEFAULT_THEME, THEMED_PROPERTIES, superegoTheme, themeAccent, themeStyle, type Appearance, type Theme } from '../src/themes/index.ts'
import { colourTokens } from '../src/tokens.ts'

// ── What's chosen, kept in the address ──────────────────────────────────────────────────────────────────────────────

type Scheme = 'light' | 'dark' | 'system'
type Settings = { scheme: Scheme; light: string; dark: string; match: boolean; accent: string | null; size: number; view: 'desktop' | 'phone' }

const DEFAULT_ACCENT = '#007aff'
const ACCENTS = ['#007aff', '#8e5cf7', '#ff2d55', '#ff3b30', '#ff9500', '#28cd41', '#8e8e93']
const params = new URLSearchParams(location.search)
const EMBEDDED = params.has('embed')

function read(): Settings {
  const scheme = params.get('scheme')
  return {
    scheme: scheme === 'light' || scheme === 'dark' ? scheme : 'system',
    light: params.get('light') ?? DEFAULT_THEME,
    dark: params.get('dark') ?? DEFAULT_THEME,
    match: params.get('match') === '1',
    accent: params.get('accent'),
    size: Number(params.get('size')) || 1,
    view: params.get('view') === 'phone' ? 'phone' : 'desktop',
  }
}

/** The settings as an address's query: only what differs from the defaults. */
function query(settings: Settings, more: Record<string, string> = {}) {
  const q = new URLSearchParams()
  if (settings.scheme !== 'system') q.set('scheme', settings.scheme)
  if (settings.light !== DEFAULT_THEME) q.set('light', settings.light)
  if (settings.dark !== DEFAULT_THEME) q.set('dark', settings.dark)
  if (settings.match) q.set('match', '1')
  if (settings.accent) q.set('accent', settings.accent)
  if (settings.size !== 1) q.set('size', String(settings.size))
  if (settings.view !== 'desktop') q.set('view', settings.view)
  for (const [key, value] of Object.entries(more)) q.set(key, value)
  return q.toString()
}

const themeOf = (id: string, appearance: Appearance): Theme =>
  BUILTIN_THEMES.find((t) => t.id === id && t.appearance === appearance) ?? superegoTheme(appearance)

/** The settings applied to the page's root, as the app applies its own (packages/app's themes.tsx). */
function useApplied(settings: Settings) {
  useEffect(() => {
    const root = document.documentElement.style
    root.colorScheme = settings.scheme === 'system' ? '' : settings.scheme
    const light = themeOf(settings.light, 'light')
    const dark = themeOf(settings.dark, 'dark')
    const style = themeStyle(light, dark, settings.match)
    for (const property of THEMED_PROPERTIES) if (!(property in style)) root.removeProperty(property)
    for (const [property, value] of Object.entries(style)) root.setProperty(property, value)
    const themed = settings.accent ? undefined : themeAccent(light, dark, DEFAULT_ACCENT, settings.match)
    const accent = themed?.accent ?? settings.accent
    if (accent) root.setProperty('--superego-accent-base', accent)
    else root.removeProperty('--superego-accent-base')
    if (themed) root.setProperty('--superego-accent-text', themed.text)
    else root.removeProperty('--superego-accent-text')
    root.setProperty('--superego-text-size', String(settings.size))
    if (!EMBEDDED) history.replaceState(null, '', `?${query(settings, params.has('open') ? { open: params.get('open')! } : {})}${location.hash}`)
  }, [JSON.stringify(settings)])
}

/** Whether the page is drawn dark now: as chosen, or as the system is. */
function useDark(scheme: Scheme) {
  const [system, setSystem] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const list = matchMedia('(prefers-color-scheme: dark)')
    const changed = () => setSystem(list.matches)
    list.addEventListener('change', changed)
    return () => list.removeEventListener('change', changed)
  }, [])
  return scheme === 'system' ? system : scheme === 'dark'
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  ['dialogs', 'Dialogs'], ['buttons', 'Buttons'], ['fields', 'Fields & controls'], ['menus', 'Menus & overlays'],
  ['lists', 'Lists & panels'], ['status', 'Status & machines'], ['tokens', 'Tokens & type'],
] as const

function Playground() {
  const [settings, setSettings] = useState(read)
  const set = (patch: Partial<Settings>) => setSettings((was) => ({ ...was, ...patch }))
  useApplied(settings)
  const dark = useDark(settings.scheme)
  const active = useActiveSection()
  if (EMBEDDED) return <main className="pg__main pg__main--embedded"><Gallery /></main>
  return (
    <TooltipProvider>
      <div className="pg">
        <aside className="pg__rail">
          <div className="pg__brand"><SparkleIcon size={16} weight="fill" aria-hidden /> Superego UI</div>
          <nav className="pg__nav" aria-label="Sections">
            {SECTIONS.map(([id, title]) => <a key={id} href={`#${id}`} className={active === id ? 'is-active' : ''}>{title}</a>)}
          </nav>
          <Controls settings={settings} set={set} dark={dark} />
        </aside>
        {settings.view === 'phone' ? (
          <main className="pg__main pg__phone">
            {/* The gallery at a phone's width, in a frame of its own: the stylesheets' media queries follow the frame. */}
            <iframe key={query(settings)} title="At a phone's width" src={`?${query({ ...settings, view: 'desktop' }, { embed: '1' })}`} />
          </main>
        ) : (
          <main className="pg__main" id="top"><Gallery /></main>
        )}
      </div>
    </TooltipProvider>
  )
}

function Controls({ settings, set, dark }: { settings: Settings; set(patch: Partial<Settings>): void; dark: boolean }) {
  const appearance: Appearance = dark ? 'dark' : 'light'
  const themes = [superegoTheme('light'), superegoTheme('dark'), ...BUILTIN_THEMES]
  return (
    <div className="pg__controls">
      <Control label="Appearance">
        <SegmentedControl label="Appearance" value={settings.scheme} onChange={(scheme) => set({ scheme })}
          options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Auto' }]} />
      </Control>
      <Control label="Theme">
        <Select aria-label="Theme" className="pg__select" value={`${appearance}:${settings[appearance]}`}
          options={themes.map((t) => ({ value: `${t.appearance}:${t.id}`, label: t.name, group: t.appearance === 'light' ? 'Light' : 'Dark' }))}
          onChange={(value) => {
            const [kind, id] = (value ?? '').split(':') as [Appearance, string]
            set({ [kind]: id, scheme: kind })
          }} />
        <label className="pg__switch">Match window<Switch label="Match window" checked={settings.match} onChange={(match) => set({ match })} /></label>
      </Control>
      <Control label="Accent">
        <div className="superego-swatches" role="radiogroup" aria-label="Accent">
          <button type="button" role="radio" aria-checked={settings.accent === null} aria-label="The theme's" title="The theme's"
            className="superego-swatch pg__swatch-auto" onClick={() => set({ accent: null })} />
          {ACCENTS.map((colour) => (
            <button key={colour} type="button" role="radio" aria-checked={settings.accent === colour} aria-label={colour} title={colour}
              className="superego-swatch" style={{ background: colour }} onClick={() => set({ accent: colour })} />
          ))}
        </div>
      </Control>
      <Control label={`Text size ${Math.round(settings.size * 100)}%`}>
        <Slider label="Text size" min={0.85} max={1.3} step={0.05} value={settings.size} onChange={(size) => set({ size: Math.round(size * 100) / 100 })} />
      </Control>
      <Control label="Width">
        <SegmentedControl label="Width" value={settings.view} onChange={(view) => set({ view })}
          options={[{ value: 'desktop', label: 'Desktop', icon: LaptopIcon }, { value: 'phone', label: 'Phone (390px)', icon: DeviceMobileIcon }]} />
      </Control>
    </div>
  )
}

const Control = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="pg__control"><span className="pg__control-label">{label}</span>{children}</div>
)

/** The section scrolled to: the last whose top is above the middle of the view. */
function useActiveSection() {
  const [active, setActive] = useState<string>(SECTIONS[0][0])
  useEffect(() => {
    const main = document.querySelector('.pg__main')
    if (!main) return
    const follow = () => {
      const middle = main.getBoundingClientRect().top + main.clientHeight / 3
      const passed = SECTIONS.filter(([id]) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= middle)
      setActive(passed.at(-1)?.[0] ?? SECTIONS[0][0])
    }
    main.addEventListener('scroll', follow, { passive: true })
    return () => main.removeEventListener('scroll', follow)
  }, [])
  return active
}

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="pg-section">
      <h2 className="pg-section__title">{title}</h2>
      {note && <p className="pg-section__note">{note}</p>}
      {children}
    </section>
  )
}

const Specimen = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="pg-specimen">{children}<span className="pg-specimen__label">{label}</span></div>
)

function Gallery() {
  return (
    <div className="pg__content">
      <Dialogs />
      <Buttons />
      <Fields />
      <Menus />
      <Lists />
      <Statuses />
      <Tokens />
    </div>
  )
}

// ── Dialogs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const TAKEN = ['Shoes', 'Socks']

function Dialogs() {
  const [open, setOpen] = useState<string | null>(params.get('open'))
  const close = () => setOpen(null)
  const opener = (id: string, label: string) => <Button onClick={() => setOpen(id)}>{label}</Button>
  return (
    <Section id="dialogs" title="Dialogs" note={<>The surfaces as drawn, then the real thing: open one to try its keys (Escape, Enter, Tab), its focus and its backdrop.</>}>
      <div className="pg-stage">
        <StillAlert title="Delete “Shoes”?" message="Its file goes; this can't be undone." buttons={<><Button>Cancel</Button><Button variant="danger">Delete</Button></>} />
        <StillAlert title="Rename canvas" buttons={<><Button>Cancel</Button><Button variant="primary">Rename</Button></>}>
          <input className="superego-field superego-alert__field pg-focused" defaultValue="Fox & Rhino" aria-label="Name" />
        </StillAlert>
        <StillAlert title="Rename canvas" buttons={<><Button>Cancel</Button><Button variant="primary" disabled>Rename</Button></>}>
          <input className="superego-field superego-alert__field" defaultValue="Shoes" aria-label="Name" aria-invalid />
          <p className="superego-alert__error">There's a “Shoes” already.</p>
        </StillAlert>
        <StillAlert title="Archive 3 threads?" message="They leave the sidebar; Archived brings them back." buttons={<><Button>Cancel</Button><Button variant="primary">Archive</Button></>} />
        <StillDialog />
      </div>
      <div className="pg-row pg-openers">
        <Specimen label="ConfirmDialog">{opener('confirm-delete', 'Delete…')}{opener('confirm-archive', 'Archive…')}{opener('confirm-fails', 'Delete (fails)…')}</Specimen>
        <Specimen label="PromptDialog">{opener('prompt-rename', 'Rename…')}{opener('prompt-new', 'New folder…')}{opener('prompt-slow', 'Rename (slow)…')}</Specimen>
        <Specimen label="Dialog">{opener('dialog-small', 'Small')}{opener('dialog-medium', 'Medium')}{opener('dialog-large', 'Large')}{opener('dialog-flush', 'Flush')}</Specimen>
      </div>

      {open === 'confirm-delete' && <ConfirmDialog title="Delete “Shoes”?" description="Its file goes; this can't be undone." confirmLabel="Delete" tone="danger" onConfirm={() => wait(600)} onClose={close} />}
      {open === 'confirm-archive' && <ConfirmDialog title="Archive 3 threads?" description="They leave the sidebar; Archived brings them back." confirmLabel="Archive" onConfirm={() => {}} onClose={close} />}
      {open === 'confirm-fails' && (
        <ConfirmDialog title="Delete “Shoes”?" description="Its file goes; this can't be undone." confirmLabel="Delete" tone="danger" onClose={close}
          onConfirm={async () => { await wait(500); throw new Error('The file is open in another window.') }} />
      )}
      {open === 'prompt-rename' && (
        <PromptDialog title="Rename canvas" defaultValue="Fox & Rhino" confirmLabel="Rename" onSubmit={() => wait(300)} onClose={close}
          validate={(name) => TAKEN.includes(name) ? `There's a “${name}” already.` : undefined} />
      )}
      {open === 'prompt-new' && <PromptDialog title="New folder" description="In ~/notes" label="Name" placeholder="Untitled" confirmLabel="Create" onSubmit={() => {}} onClose={close} />}
      {open === 'prompt-slow' && <PromptDialog title="Rename thread" defaultValue="Parse the bank's dates" confirmLabel="Rename" onSubmit={() => wait(1500)} onClose={close} />}
      {(open === 'dialog-small' || open === 'dialog-medium' || open === 'dialog-large') && (
        <Dialog title="Layout" size={open.slice('dialog-'.length) as 'small' | 'medium' | 'large'} onClose={close}
          footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={close}>Save</Button></>}>
          <p>A dialog's body has room around it. Its footer holds its buttons, Cancel before what it's for.</p>
          <TextField aria-label="Name" placeholder="A field, its ring whole" className="pg-wide" />
        </Dialog>
      )}
      {open === 'dialog-flush' && (
        <Dialog label="Go to" size="medium" flush onClose={close}>
          <input className="superego-dialog__search" placeholder="Go to…" autoFocus />
          <List className="pg-flush-list">
            {['Inbox', 'Canvas', 'Notes', 'Settings'].map((name, i) => <ListItem key={name} selected={i === 0} leading={<FileTextIcon aria-hidden />} trailing={`⌘${i + 1}`}>{name}</ListItem>)}
          </List>
        </Dialog>
      )}
    </Section>
  )
}

/** An alert's surface as ConfirmDialog and PromptDialog draw it, still and in the page (dialog.tsx has the real one). */
function StillAlert({ title, message, buttons, children }: { title: string; message?: string; buttons: ReactNode; children?: ReactNode }) {
  return (
    <div className="superego-alert" role="presentation">
      <h2 className="superego-alert__title">{title}</h2>
      {message && <p className="superego-alert__message">{message}</p>}
      {children}
      <div className="superego-alert__actions">{buttons}</div>
    </div>
  )
}

/** A Dialog's frame, still: header, body and footer. */
function StillDialog() {
  return (
    <div className="superego-dialog superego-dialog--small" role="presentation">
      <div className="superego-dialog__frame">
        <header className="superego-dialog__header">
          <h2 className="superego-dialog__title">Add an MCP server</h2>
          <div className="superego-dialog__actions"><IconButton label="Close" className="superego-dialog__close">✕</IconButton></div>
        </header>
        <div className="superego-dialog__body">
          <p className="pg-muted">A body with room around it, and a footer.</p>
          <TextField aria-label="URL" placeholder="https://mcp.linear.app/mcp" className="pg-wide" />
        </div>
        <footer className="superego-dialog__footer"><Button>Cancel</Button><Button variant="primary">Add</Button></footer>
      </div>
    </div>
  )
}

// ── Buttons ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function Buttons() {
  return (
    <Section id="buttons" title="Buttons">
      <div className="pg-row">
        <Specimen label="default"><Button>Cancel</Button></Specimen>
        <Specimen label="primary"><Button variant="primary">Save</Button></Specimen>
        <Specimen label="danger"><Button variant="danger">Delete</Button></Specimen>
        <Specimen label="ghost"><Button variant="ghost">Show more</Button></Specimen>
        <Specimen label="disabled"><div className="pg-inline"><Button disabled>Cancel</Button><Button variant="primary" disabled>Save</Button><Button variant="danger" disabled>Delete</Button></div></Specimen>
        <Specimen label="with an icon"><div className="pg-inline"><Button><PlusIcon aria-hidden /> New thread</Button><Button variant="primary"><GitBranchIcon aria-hidden /> Merge</Button></div></Specimen>
        <Specimen label="IconButton">
          <div className="pg-inline">
            {[[PlusIcon, 'Add'], [PencilSimpleIcon, 'Rename'], [CopyIcon, 'Copy'], [GearSixIcon, 'Settings'], [XIcon, 'Close']].map(([Icon, label]) => {
              const Drawn = Icon as typeof PlusIcon
              return <Tooltip key={label as string} content={label as string} side="bottom"><IconButton label={label as string}><Drawn aria-hidden /></IconButton></Tooltip>
            })}
          </div>
        </Specimen>
      </div>
    </Section>
  )
}

// ── Fields & controls ───────────────────────────────────────────────────────────────────────────────────────────────

const FONTS = ['Helvetica Neue', 'Inter', 'Georgia', 'Iowan Old Style', 'Menlo', 'SF Mono', 'JetBrains Mono', 'Courier New', 'Times New Roman', 'Verdana']

function Fields() {
  const [model, setModel] = useState<string | null>('opus')
  const [where, setWhere] = useState<string | null>(null)
  const [on, setOn] = useState(true)
  const [mode, setMode] = useState<'rendered' | 'live' | 'source'>('live')
  const [layout, setLayout] = useState<'list' | 'cards'>('list')
  const [volume, setVolume] = useState(0.4)
  const [steps, setSteps] = useState(3)
  const [font, setFont] = useState<string | null>(null)
  const models = [
    { value: 'opus', label: 'Claude Opus', group: 'Anthropic' }, { value: 'sonnet', label: 'Claude Sonnet', group: 'Anthropic' },
    { value: 'gpt', label: 'GPT-5', group: 'OpenAI' }, { value: 'gemini', label: 'Gemini 3', group: 'Google' },
  ]
  return (
    <Section id="fields" title="Fields & controls">
      <div className="pg-grid">
        <Specimen label="TextField"><TextField aria-label="Name" defaultValue="Fox & Rhino" /></Specimen>
        <Specimen label="placeholder"><TextField aria-label="Search" placeholder="Search threads" /></Specimen>
        <Specimen label="disabled"><TextField aria-label="Disabled" defaultValue="workbox" disabled /></Specimen>
        <Specimen label="TextArea"><div className="pg-textarea"><TextArea aria-label="Prompt" placeholder="Ask for anything…" maxRows={4} /></div></Specimen>
        <Specimen label="Select, grouped"><Select aria-label="Model" value={model} onChange={setModel} options={models} /></Specimen>
        <Specimen label="Select, placeholder"><Select aria-label="Mixed" value={null} placeholder="Mixed" onChange={() => {}} options={models} /></Specimen>
        <Specimen label="Select, nullLabel"><Select aria-label="Machine" value={where} nullLabel="This machine" onChange={setWhere} options={[{ value: 'box', label: 'workbox' }, { value: 'mini', label: 'mac-mini' }]} /></Specimen>
        <Specimen label="Switch"><div className="pg-inline"><Switch label="On" checked={on} onChange={setOn} /><Switch label="Off" checked={!on} onChange={(v) => setOn(!v)} /><Switch label="Disabled" checked disabled onChange={() => {}} /></div></Specimen>
        <Specimen label="SegmentedControl">
          <SegmentedControl<typeof mode> label="Mode" value={mode} onChange={setMode} options={[{ value: 'rendered', label: 'Rendered' }, { value: 'live', label: 'Live' }, { value: 'source', label: 'Source' }]} />
        </Specimen>
        <Specimen label="SegmentedControl, icons">
          <SegmentedControl<typeof layout> label="Layout" value={layout} onChange={setLayout} options={[{ value: 'list', label: 'List', icon: FileTextIcon }, { value: 'cards', label: 'Folders', icon: FolderSimpleIcon }]} />
        </Specimen>
        <Specimen label="Slider"><div className="pg-slider"><Slider label="Volume" min={0} max={1} value={volume} onChange={setVolume} /></div></Specimen>
        <Specimen label="Slider, stepped"><div className="pg-slider"><Slider label="Thinking" min={0} max={5} step={1} value={steps} onChange={setSteps} /></div></Specimen>
        <Specimen label="FontPicker"><FontPicker label="Font" value={font} onChange={setFont} loadFonts={async () => FONTS} /></Specimen>
      </div>
    </Section>
  )
}

// ── Menus & overlays ────────────────────────────────────────────────────────────────────────────────────────────────

function Menus() {
  const [sort, setSort] = useState('recent')
  const [unread, setUnread] = useState(true)
  return (
    <Section id="menus" title="Menus & overlays">
      <div className="pg-row">
        <Specimen label="Menu">
          <Menu.Root>
            <Menu.Trigger render={<Button />}>Thread <span aria-hidden>⌄</span></Menu.Trigger>
            <Menu.Popup>
              <Menu.Item hint="⌘R">Rename</Menu.Item>
              <Menu.Item hint="⌘D">Duplicate</Menu.Item>
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger>Move to</Menu.SubmenuTrigger>
                <Menu.SubmenuPopup><Menu.Item>superego</Menu.Item><Menu.Item>site</Menu.Item></Menu.SubmenuPopup>
              </Menu.SubmenuRoot>
              <Menu.Separator />
              <Menu.Group>
                <Menu.GroupLabel>Sort by</Menu.GroupLabel>
                <Menu.RadioGroup value={sort} onValueChange={setSort}>
                  <Menu.RadioItem value="recent">Recent</Menu.RadioItem>
                  <Menu.RadioItem value="name">Name</Menu.RadioItem>
                </Menu.RadioGroup>
              </Menu.Group>
              <Menu.CheckboxItem checked={unread} onCheckedChange={setUnread}>Unread first</Menu.CheckboxItem>
              <Menu.Separator />
              <Menu.Item disabled>Archive</Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        </Specimen>
        <Specimen label="ContextMenu">
          <ContextMenu.Root>
            <ContextMenu.Trigger><div className="pg-target">Right-click here</div></ContextMenu.Trigger>
            <ContextMenu.Popup>
              <Menu.Item hint="⌘C">Copy</Menu.Item>
              <Menu.Item>Open beside</Menu.Item>
              <Menu.Separator />
              <Menu.Item>Delete</Menu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Root>
        </Specimen>
        <Specimen label="Popover">
          <Popover trigger={<Button>Details</Button>} align="start">
            <div className="pg-popover">
              <strong>workbox</strong>
              <span className="pg-muted">Connected over Tailscale · 3 threads working</span>
            </div>
          </Popover>
        </Specimen>
        <Specimen label="Tooltip"><Tooltip content="Search threads (⌘K)" side="bottom"><IconButton label="Search"><MagnifyingGlassIcon aria-hidden /></IconButton></Tooltip></Specimen>
        <Specimen label="HoverCard">
          <HoverCard side="bottom" card={<><strong>Parse the bank's dates</strong><div className="pg-muted">Working · 4 minutes</div></>}>
            <span className="pg-target pg-target--small" tabIndex={0}>Point at me</span>
          </HoverCard>
        </Specimen>
      </div>
    </Section>
  )
}

// ── Lists & panels ──────────────────────────────────────────────────────────────────────────────────────────────────

function Lists() {
  const [chosen, setChosen] = useState('canvas')
  const rows: [string, string, ReactNode, string][] = [
    ['inbox', 'Inbox', <Glyph shape="done" />, '2m'], ['canvas', 'Rename the canvas', <Glyph shape="working" />, 'now'],
    ['notes', 'Release notes', <Glyph shape="question" />, '1h'], ['terminal', 'Terminal', <TerminalIcon aria-hidden />, ''],
  ]
  return (
    <Section id="lists" title="Lists & panels">
      <div className="pg-row">
        <Specimen label="List, ListItem">
          <List className="pg-list" aria-label="Threads">
            {rows.map(([id, title, leading, trailing]) => (
              <ListItem key={id} selected={chosen === id} leading={leading} trailing={trailing} onClick={() => setChosen(id)}>{title}</ListItem>
            ))}
          </List>
        </Specimen>
        <Specimen label="Panel">
          <Panel className="pg-panel" title="Files" actions={<IconButton label="Add"><PlusIcon aria-hidden /></IconButton>}>
            <List aria-label="Files">
              <ListItem leading={<FolderSimpleIcon aria-hidden />}>packages</ListItem>
              <ListItem leading={<FileTextIcon aria-hidden />} trailing="2 KB">README.md</ListItem>
              <ListItem leading={<ArchiveIcon aria-hidden />} trailing="12">archive</ListItem>
            </List>
          </Panel>
        </Specimen>
      </div>
    </Section>
  )
}

// ── Status & machines ───────────────────────────────────────────────────────────────────────────────────────────────

const SHAPES: GlyphShape[] = ['idle', 'working', 'done', 'question', 'permission', 'signin', 'error', 'queued', 'stalled', 'landed', 'offline', 'connecting']
const STATUSES: [string, Status, boolean?][] = [
  ['idle', { state: 'idle' }], ['working', { state: 'working' }], ['working, quiet', { state: 'working' }, true], ['done', { state: 'done', msg: 'Shipped it' }],
  ['question', { state: 'blocked', kind: 'question' }], ['permission', { state: 'blocked', kind: 'permission' }],
  ['sign in', { state: 'blocked', kind: 'auth' }], ['error', { state: 'error', msg: 'Out of credits' }],
]
const PROVIDERS = ['anthropic', 'openai', 'google', 'mistral', 'xai', 'openrouter', 'github-copilot', 'deepseek']

function Statuses() {
  const [colour, setColour] = useState(1)
  return (
    <Section id="status" title="Status & machines">
      <div className="pg-row pg-row--tight">
        {SHAPES.map((shape) => <Specimen key={shape} label={shape}><span className="pg-big"><Glyph shape={shape} label={shape} /></span></Specimen>)}
        <Specimen label="stale"><span className="pg-big is-stale"><Glyph shape="working" label="Working, as last seen" /></span></Specimen>
      </div>
      <div className="pg-row pg-row--tight">
        {STATUSES.map(([label, status, quiet]) => (
          <Specimen key={label} label={label}><span className="pg-status"><StatusGlyph status={status} quiet={quiet} /> <StatusWord status={status} quiet={quiet} /></span></Specimen>
        ))}
      </div>
      <div className="pg-row">
        <Specimen label="MachineName"><div className="pg-inline pg-machines">{Array.from({ length: 8 }, (_, i) => <MachineName key={i} machine={{ label: `box-${i + 1}`, colour: i + 1 }} />)}</div></Specimen>
        <Specimen label="ColourSwatches"><ColourSwatches value={colour} onPick={setColour} /></Specimen>
        <Specimen label="ProviderMark"><div className="pg-inline">{PROVIDERS.map((p) => <span key={p} title={p}><ProviderMark provider={p} size={16} /></span>)}</div></Specimen>
      </div>
    </Section>
  )
}

// ── Tokens & type ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Tokens that are a shadow or a ring rather than a colour: drawn around a swatch, not in it. */
const SHADOW = /edge|region-ring|--superego-focus$/
const TYPE = ['xs', 'sm', 'ui', 'body', 'mono', 'title', 'field'] as const

function Tokens() {
  return (
    <Section id="tokens" title="Tokens & type" note={<>Every colour from <code>tokens.ts</code>, as the theme and appearance draw it now.</>}>
      {Object.entries(colourTokens).map(([group, tokens]) => (
        <div key={group} className="pg-tokens">
          <h3 className="pg-tokens__group">{group}</h3>
          <div className="pg-tokens__grid">
            {Object.entries(tokens).map(([token, role]) => (
              <div key={token} className="pg-token" title={role}>
                <span className="pg-token__swatch" style={SHADOW.test(token) ? { boxShadow: `var(${token})` } : { background: `var(${token})` }} />
                <code className="pg-token__name">{token.replace('--superego-', '')}</code>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="pg-type">
        {TYPE.map((size) => (
          <div key={size} className="pg-type__row">
            <code className="pg-type__name">text-{size}</code>
            <span style={{ fontSize: `var(--superego-text-${size})`, fontFamily: size === 'mono' ? 'var(--superego-mono)' : undefined }}>The fox and the rhino rename the canvas</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Playground /></StrictMode>)

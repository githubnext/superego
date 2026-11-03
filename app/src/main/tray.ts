// The menu bar item: a µ (and a count when sessions want a look) while the "Show in menu bar" setting is on. Its menu
// shows what the agents are doing on every machine and is the way back to the app when no window is open.
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { SessionInfo } from '@mu/protocol'
import type { MachineEntry } from '../shared.ts'

export type TrayModel = {
  machines(): MachineEntry[]
  sessions(machine: string): SessionInfo[]
  open(): void
  openSession(machine: string, session: string): void
  openSettings(): void
  quit(): void
  quitAndStop(): void
  service(): { phase: string; busy: boolean }
  restart(): void
}

const GLYPH: Record<string, string> = { working: '●', done: '*', blocked: '?', error: '!' }
const WANTS_A_LOOK = new Set(['done', 'blocked', 'error'])

export class MenuBar {
  #tray: Tray | undefined
  #model: TrayModel
  #headless: boolean

  constructor(model: TrayModel, headless: boolean) {
    this.#model = model
    this.#headless = headless
  }

  #headlessShown = false
  /** What the item last showed, so an unchanged redraw leaves it (and an open menu) alone. */
  #drawn = ''
  /** Whether the item is up (or, headless, would be). */
  get shown() { return Boolean(this.#tray) || this.#headlessShown }

  /** Show or hide the item, and redraw it from the current machines and sessions. */
  update(visible: boolean) {
    if (!visible) {
      this.#tray?.destroy()
      this.#tray = undefined
      this.#headlessShown = false
      this.#drawn = ''
      return
    }
    // Tests run headless: no item appears on the desktop, but they can tell it would, and break where it would.
    if (!app.isReady()) throw new Error('Cannot create Tray before app is ready')
    if (this.#headless) { this.#headlessShown = true; return }
    if (!this.#tray) {
      // No image, just text: the title draws in the menu bar's own font and colour, light or dark.
      this.#tray = new Tray(nativeImage.createEmpty())
      this.#tray.setToolTip('mu')
    }
    const machines = this.#model.machines().filter((m) => m.state !== 'disabled')
    const all = machines.flatMap((m) => this.#model.sessions(m.id).map((session) => ({ machine: m, session })))
    const wanting = all.filter(({ session }) => WANTS_A_LOOK.has(session.status.state))
    const working = all.filter(({ session }) => session.status.state === 'working')
    const title = wanting.length ? `µ ${wanting.length}` : 'µ'
    const tooltip = working.length ? `mu: ${working.length} working` : 'mu'

    const item = ({ machine, session }: (typeof all)[number]): MenuItemConstructorOptions => ({
      label: `${GLYPH[session.status.state] ?? '○'}  ${session.title}${machines.length > 1 ? `  — ${machine.label}` : ''}`,
      click: () => this.#model.openSession(machine.id, session.id),
    })
    const listed = [...wanting, ...working].slice(0, 12)
    const service = this.#model.service()
    const restart: MenuItemConstructorOptions[] = service.phase === 'current' ? [] : [{
      label: service.phase === 'restarting' ? 'Restarting background process…' : service.phase === 'waiting' ? 'Restart waits until agents are idle'
        : service.busy ? 'Restart background process when idle' : 'Restart background process (update ready)',
      enabled: service.phase === 'required' || service.phase === 'error',
      click: () => this.#model.restart(),
    }, { type: 'separator' }]
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open mu', click: () => this.#model.open() },
      { type: 'separator' },
      ...restart,
      ...(listed.length ? listed.map(item) : [{ label: 'Nothing running', enabled: false }]),
      { type: 'separator' },
      ...machines.map((m): MenuItemConstructorOptions => ({
        label: `${m.label}: ${m.state === 'connected' ? 'running' : m.state}`, enabled: false,
      })),
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => this.#model.openSettings() },
      { label: 'Quit mu', click: () => this.#model.quit() },
      { label: 'Quit and Stop Agents', click: () => this.#model.quitAndStop() },
    ]
    const drawn = JSON.stringify([title, tooltip, template.map((item) => [item.label, item.enabled, item.type])])
    if (drawn === this.#drawn) return
    this.#drawn = drawn
    this.#tray.setTitle(title, { fontType: 'monospacedDigit' })
    this.#tray.setToolTip(tooltip)
    this.#tray.setContextMenu(Menu.buildFromTemplate(template))
  }
}

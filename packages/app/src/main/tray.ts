// The menu bar item: the app's icon (and a count when threads want a look) while the "Show in menu bar" setting is on.
// Its menu shows what the agents are doing on every machine and is the way back to the app when no window is open.
// The icon is the app's `resources/trayTemplate.png` (with an @2x beside it): black on transparent, which macOS tints
// for the menu bar it sits in. Without one, the app's glyph is drawn as text.
import { existsSync } from 'node:fs'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { AppConfig, ThreadInfo } from '@mu/protocol'
import type { MachineEntry } from '../shared.ts'

export type TrayModel = {
  machines(): MachineEntry[]
  threads(machine: string): ThreadInfo[]
  open(): void
  openThread(machine: string, thread: string): void
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

  #app: AppConfig

  #icon: string | undefined

  constructor(app: AppConfig, model: TrayModel, headless: boolean, icon?: string) {
    this.#app = app
    this.#model = model
    this.#headless = headless
    this.#icon = icon && existsSync(icon) ? icon : undefined
  }

  #headlessShown = false
  /** What the item last showed, so an unchanged redraw leaves it (and an open menu) alone. */
  #drawn = ''
  /** Whether the item is up (or, headless, would be). */
  get shown() { return Boolean(this.#tray) || this.#headlessShown }

  /** Show or hide the item, and redraw it from the current machines and threads. */
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
      // A template image, or else just text: either way it takes the menu bar's own colour, light or dark.
      const image = this.#icon ? nativeImage.createFromPath(this.#icon) : nativeImage.createEmpty()
      image.setTemplateImage(true)
      this.#tray = new Tray(image)
      this.#tray.setToolTip(this.#app.name)
    }
    const machines = this.#model.machines().filter((m) => m.state !== 'disabled')
    const all = machines.flatMap((m) => this.#model.threads(m.id).map((thread) => ({ machine: m, thread })))
    const wanting = all.filter(({ thread }) => WANTS_A_LOOK.has(thread.status.state))
    const working = all.filter(({ thread }) => thread.status.state === 'working')
    const glyph = this.#app.glyph ?? this.#app.name
    const count = wanting.length ? String(wanting.length) : ''
    const title = this.#icon ? count : count ? `${glyph} ${count}` : glyph
    const tooltip = working.length ? `${this.#app.name}: ${working.length} working` : this.#app.name

    const item = ({ machine, thread }: (typeof all)[number]): MenuItemConstructorOptions => ({
      label: `${GLYPH[thread.status.state] ?? '○'}  ${thread.title}${machines.length > 1 ? `  — ${machine.label}` : ''}`,
      click: () => this.#model.openThread(machine.id, thread.id),
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
      { label: `Open ${this.#app.name}`, click: () => this.#model.open() },
      { type: 'separator' },
      ...restart,
      ...(listed.length ? listed.map(item) : [{ label: 'Nothing running', enabled: false }]),
      { type: 'separator' },
      ...machines.map((m): MenuItemConstructorOptions => ({
        label: `${m.label}: ${m.state === 'connected' ? 'running' : m.state}`, enabled: false,
      })),
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => this.#model.openSettings() },
      { label: `Quit ${this.#app.name}`, click: () => this.#model.quit() },
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

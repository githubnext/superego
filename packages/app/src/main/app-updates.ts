// The released app updating itself with Electron's autoUpdater (Squirrel.Mac), from its feed: a JSON file that names
// the newest release and where its zip is (written by `pnpm release`, see docs/releasing.md). It checks a little after
// launch and every few hours, downloads in the background, and the windows offer a restart once one is ready
// (updates.ts has the logic). Only a released app has a feed: run from source, or packaged here, it never updates itself.
// Nor does one macOS runs translocated (translocation.ts): Squirrel can't replace that copy, so it waits to be moved.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, autoUpdater, dialog, net } from 'electron'
import { appEnv } from '@superego/daemon/client'
import { envName, type AppConfig } from '@superego/protocol'
import type { UpdateState } from '../shared/updates.ts'
import type { Service } from './service.ts'
import type { MoveWording } from './translocation.ts'
import { Updates } from './updates.ts'

const FIRST_CHECK = 10_000
const EVERY = 4 * 60 * 60_000

/**
 * Where this app's updates come from: `updateFeed` in its package.json, which a release's build writes there (from the
 * app config's `updateFeed`), or `<ID>_UPDATE_FEED` (a feed of test builds, say). None but in a packaged app (`dir`, its
 * out/main, in an app.asar): `app.isPackaged` is true of `pnpm dev`'s Electron too.
 */
export function updateFeed(appConfig: AppConfig, dir: string): string | undefined {
  if (!/\.asar([/\\]|$)/.test(dir)) return undefined
  const override = appEnv(appConfig)('UPDATE_FEED')
  // Not passed on to the daemon this starts, nor its agents.
  delete process.env[envName(appConfig, 'UPDATE_FEED')]
  if (override) return override
  try {
    const { updateFeed: feed } = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { updateFeed?: unknown }
    return typeof feed === 'string' && feed ? feed : undefined
  } catch (error) {
    console.error(`Updates are off: the app's package.json can't be read (${error instanceof Error ? error.message : String(error)})`)
    return undefined
  }
}

export type AppUpdates = ReturnType<typeof createAppUpdates>

export function createAppUpdates({ app: appConfig, headless, translocated, offerMove, service, quitting, changed }: {
  app: AppConfig
  headless: boolean
  /** Run by macOS from a temporary copy: it can't update until it's moved to Applications. */
  translocated: boolean
  /** Offer, in `wording`, to move the app to Applications, as the menu's Check for Updates… does when it's translocated. */
  offerMove(wording: MoveWording): Promise<void>
  service: Pick<Service, 'stopForUpdate' | 'relink'>
  /** The app is about to quit: every window open comes back after the update. */
  quitting(): void
  changed(state: UpdateState): void
}) {
  const released = headless ? undefined : updateFeed(appConfig, import.meta.dirname)
  // A released app run from a temporary copy: no feed until it's moved.
  const stuck = Boolean(released && translocated)
  if (stuck) console.error(`Updates are off: ${appConfig.name} runs from a temporary folder (App Translocation), not Applications`)
  const feed = stuck ? undefined : released
  const updates = new Updates(app.getVersion(), feed ? {
    check: () => autoUpdater.checkForUpdates(),
    online: () => net.isOnline(),
    prepare: () => service.stopForUpdate(),
    install() {
      // quitAndInstall closes the windows before the app's before-quit: they'd be forgotten as closed.
      quitting()
      autoUpdater.quitAndInstall()
    },
    recover: () => service.relink(),
    changed,
  } : undefined, stuck)

  function start() {
    if (!feed) return
    autoUpdater.on('checking-for-update', () => updates.checking())
    autoUpdater.on('update-available', () => updates.available())
    autoUpdater.on('update-not-available', () => updates.notAvailable())
    autoUpdater.on('update-downloaded', (_event, _notes, name) => updates.downloaded(name))
    autoUpdater.on('error', (error) => updates.failed(error))
    try {
      autoUpdater.setFeedURL({ url: feed, serverType: 'json' })
    } catch (error) {
      // Unsigned, say: Squirrel can't tell an update is this app's. Settings says so.
      updates.failed(error)
      return
    }
    setTimeout(() => void updates.check(), FIRST_CHECK).unref()
    setInterval(() => void updates.check(), EVERY).unref()
  }

  /** The app menu's Check for Updates…: says how it went, unless the update is coming (the windows' notice shows it). */
  async function checkFromMenu() {
    const state = await updates.check(true)
    if (state.phase === 'translocated') {
      await offerMove({
        message: `Move ${appConfig.name} to Applications to receive updates`,
        detail: `It's running from a temporary folder, like Downloads, where it can't update.`,
      })
    } else if (state.phase === 'idle') {
      await dialog.showMessageBox({ message: `${appConfig.name} ${state.version} is up to date.` })
    } else if (state.phase === 'error') {
      await dialog.showMessageBox({ type: 'warning', message: 'Couldn\'t check for updates', detail: state.error ?? '' })
    }
  }

  return {
    get state() { return updates.state },
    /** A released app: the menu has Check for Updates… (which, translocated, offers the move). */
    on: Boolean(released),
    start,
    check: () => updates.check(true),
    checkFromMenu,
    install: () => updates.install(),
  }
}

// The one harness for the scripts that drive the real app in Electron: smoke, the look scripts, showcase, and the evals'
// window checks (evals/lib/window.mjs). It loads the app's main, waits for its window, and drives it: run code in a page,
// wait for a condition, press keys, click, type, screenshot.
//
// Every wait is on a condition or an event, never a fixed time. A wait that runs out, a check that fails or anything
// uncaught ends the run: what the page says and the daemon's log are printed, a screenshot is kept where screenshots go,
// and the app exits 1.
//
//   import { openApp } from './harness.mjs'
//   await openApp({ name: 'look', timeout: 180_000, size: [1100, 760] }, async (t) => {
//     await t.call('thread.start', { title: 'x' })
//     await t.until(`Boolean(document.querySelector('.superego-list-item'))`, 'the thread listed')
//     await t.shot('sidebar')
//   })
//
// Awaited at the top of the script: it loads the app's main before Electron's `ready` and runs the body after it.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A failure the harness reports: thrown by `until`, `check` and `fail`, and caught by `openApp`. */
export class Failure extends Error {}

const FONTS = ['Arial', 'Courier', 'Georgia', 'Helvetica', 'Menlo', 'Monaco', 'Times']
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * In a page: once what's moving has finished (the page's animations and transitions, its fonts, its images) and two
 * frames have been drawn, so a screenshot shows it at rest.
 */
const AT_REST = `(async () => {
  await document.fonts?.ready
  for (let i = 0; i < 20; i++) {
    const moving = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
    const loading = [...document.images].filter((img) => !img.complete)
    if (!moving.length && !loading.length) break
    await Promise.race([Promise.all([...moving.map((a) => a.finished.catch(() => {})), ...loading.map((img) => img.decode().catch(() => {}))]), new Promise((r) => setTimeout(r, 1000))])
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return true
})()`

/**
 * Drive a page (a window's `webContents`, as a function that finds it now: a reload or a new window changes it).
 * `name` says whose it is in a failure.
 */
function driver(contentsOf, name, shotsDir) {
  const contents = () => {
    const found = contentsOf()
    if (!found || found.isDestroyed()) throw new Failure(`${name}: no page`)
    return found
  }
  const run = (js, gesture = false) => contents().executeJavaScript(js, gesture)
  const d = {
    contents,
    run,
    /**
     * Wait until `check` holds, and return what it gave: a JavaScript expression evaluated in the page (a promise it
     * gives is awaited, so `x.then((v) => v === 1)` waits for the answer), or a function run here (awaited too). An
     * error while trying counts as not yet; the last one is in the failure.
     */
    async until(check, label, ms = 15_000) {
      const end = Date.now() + ms
      let error
      for (;;) {
        try {
          const page = typeof check === 'string' ? contentsOf() : undefined
          const value = typeof check === 'function' ? await check() : page && !page.isDestroyed() && !page.isLoading() ? await page.executeJavaScript(check) : undefined
          if (value) return value
        } catch (e) { error = e }
        if (Date.now() > end) throw new Failure(`${name}: waiting for ${label}${error ? ` (last: ${error.message ?? error})` : ''}`)
        await tick(50)
      }
    },
    /** Fail unless the expression (in the page) or the function (here) gives something truthy now. */
    async check(check, label) {
      const value = typeof check === 'function' ? await check() : await run(check)
      if (!value) throw new Failure(`${name}: ${label}`)
      return value
    },
    /** A key pressed and let go, as the keyboard sends it: `key('k')` is ⌘K; give `[]` for none. */
    key(keyCode, modifiers = ['meta']) {
      contents().sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      contents().sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    /** Click the first element `selector` matches (whose text is `text`, if given), in the page. */
    async click(selector, text) {
      const found = await run(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${text === undefined ? 'true' : `el.textContent.trim() === ${JSON.stringify(text)}`})
        el?.click()
        return Boolean(el)
      })()`)
      if (!found) throw new Failure(`${name}: nothing to click at ${selector}${text === undefined ? '' : ` saying "${text}"`}`)
    },
    /** A real mouse click (or `button: 'right'`) in the middle of what `selector` matches: Chromium's own handling, not the page's. */
    async mouse(selector, { button = 'left' } = {}) {
      const at = await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      if (!at) throw new Failure(`${name}: nothing to click at ${selector}`)
      for (const type of ['mouseDown', 'mouseUp']) contents().sendInputEvent({ type, button, clickCount: 1, ...at })
    },
    /** The mouse moved over the middle of the first element `selector` matches (whose text is `text`, if given): Chromium's own pointer events. */
    async hover(selector, text) {
      const at = await run(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => ${text === undefined ? 'true' : `el.textContent.trim() === ${JSON.stringify(text)}`})
        const r = el?.getBoundingClientRect()
        return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
      if (!at) throw new Failure(`${name}: nothing to hover at ${selector}${text === undefined ? '' : ` saying "${text}"`}`)
      // From beside it first: a move within the same point wouldn't be one.
      contents().sendInputEvent({ type: 'mouseMove', x: at.x - 4, y: at.y })
      contents().sendInputEvent({ type: 'mouseMove', ...at })
    },
    /** Type into a field as React hears it (its native setter, then an input event); `enter` presses Enter after. */
    type(selector, value, { enter = false } = {}) {
      return run(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        el.focus()
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        if (${enter}) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })()`)
    },
    /** The page at rest: its animations, fonts and images done, and two frames drawn. */
    settled: () => run(AT_REST),
    /** A screenshot of the page at rest (or of an element's box, an expression) as `<shots>/<file>.png`; nothing without a shots folder. */
    async shot(file, element) {
      if (!shotsDir) return undefined
      await d.settled()
      const box = element && await run(`(() => { const r = ${element}?.getBoundingClientRect(); return r && { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } })()`)
      const path = file.startsWith('/') ? file : `${shotsDir}/${file}.png`
      writeFileSync(path, (await contents().capturePage(box?.width && box.height ? box : undefined)).toPNG())
      return path
    },
    /** A call to a machine (`local` unless given) from the page, as the window makes it. */
    call: (method, params = {}, machine = 'local') => run(`window.superego.call(${JSON.stringify(machine)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`),
    /** Focus as a window in front has it: a hidden window's page never has focus, so `:focus` styles and moves wouldn't hold. Nothing reaches the screen. */
    async emulateFocus() {
      const debug = contents().debugger
      if (!debug.isAttached()) debug.attach()
      await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    },
  }
  return d
}

/**
 * Start the app (its main, `main`: this checkout's build unless given), wait until its window is connected to this
 * machine, and run `body` with the harness. The run ends when `body` returns (exit 0, `<SUPEREGO_HOME>/passed` touched for
 * run-app.sh) or on the first failure (exit 1); `timeout` bounds it all.
 *
 * Options: `name` (in its messages), `timeout` (ms), `size` ([width, height] of the window), `shots` (the folder
 * screenshots go to: `$SUPEREGO_SHOWCASE_OUT` unless given; none, no screenshots), `connected` (wait for the local machine:
 * true unless false), `console` (`all` of the pages' console, or `errors` only), `main`, `firstRun` (the home's first run:
 * setup opens; otherwise it's set as done before the app starts), and `onFail(message)` / `onPass()` to end the run
 * another way (they exit themselves).
 */
/** Set `home`'s setup as done (its `onboarding.seen` setting), unless it was set already. */
function pastFirstRun(home) {
  const file = join(home, 'settings.json')
  let values = {}
  try { values = JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if ('onboarding.seen' in values) return
  mkdirSync(home, { recursive: true })
  writeFileSync(file, JSON.stringify({ ...values, 'onboarding.seen': true }, null, 2) + '\n', { mode: 0o600 })
}

export async function openApp(options, body) {
  const { name, timeout = 120_000, size, connected = true, main = new URL('../out/main/main.js', import.meta.url).href } = options
  const shots = 'shots' in options ? options.shots : process.env.SUPEREGO_SHOWCASE_OUT
  const win = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  const t = driver(() => win()?.webContents, name, shots)
  let ended = false
  const fail = async (message) => {
    if (ended) return
    ended = true
    console.error(`${name}: FAIL ${message}`)
    const page = win()?.webContents
    if (page) console.error('page:', (await page.executeJavaScript('document.body.innerText').catch(String)).slice(0, 2000))
    if (page && shots) await t.shot('fail').catch((error) => console.error('no screenshot of the failure:', error.message))
    // The machines as the window has them, and every daemon's log in the home (another machine's, in a folder of it, too).
    if (page) console.error('machines:', await page.executeJavaScript('window.superego.machines().then((list) => JSON.stringify(list.map(({ id, label, state, error }) => ({ id, label, state, error }))))').catch(String))
    const home = process.env.SUPEREGO_HOME
    const logs = home ? readdirSync(home, { recursive: true }).filter((path) => String(path).endsWith('daemon.log')) : []
    if (!logs.length) console.error(`no daemon.log in ${home}`)
    for (const log of logs) console.error(`${log}:`, readFileSync(`${home}/${log}`, 'utf8').slice(-2000))
    if (options.onFail) return options.onFail(message)
    app.exit(1)
  }
  // Anything uncaught in the main process fails the run: in the app it would be an error dialog.
  process.on('uncaughtException', (error) => void fail(`uncaught in main: ${error.stack ?? error}`))
  process.on('unhandledRejection', (error) => void fail(`unhandled in main: ${error?.stack ?? error}`))
  app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => {
    if (options.console === 'all' || event.level === 'error' || event.level === 'warning') console.error('renderer:', event.message)
  }))
  // The installed fonts, as the Local Font Access API gives them (where the page has it): Chromium reads every font on
  // the machine for the real list, 2,000-odd on a Mac, which takes over ten seconds alone and minutes beside other runs.
  app.on('web-contents-created', (_e, contents) => contents.on('dom-ready', () => void contents.executeJavaScript(
    `if (window.queryLocalFonts) window.queryLocalFonts = async () => ${JSON.stringify(FONTS)}.map((family) => ({ family }))`)
    // A page gone before it ran (closed, navigated away) has no fonts to list.
    .catch(() => {})))
  const deadline = setTimeout(() => void fail(`timed out after ${timeout / 1000}s`), timeout)

  Object.assign(t, {
    win,
    /** The same helpers for another page (a second window, a browser's): `t.on(() => other.webContents, 'browser')`. */
    on: (contentsOf, label = 'page') => driver(contentsOf, `${name} (${label})`, shots),
    /** End the run here, failed. */
    fail: (message) => { throw new Failure(message) },
    /**
     * Show the app in `theme` (light, dark, or system), and wait until its page has taken it on: each page given (the
     * app's window unless given) answers its colour scheme query that way, and is at rest.
     */
    async theme(theme, pages = [t]) {
      nativeTheme.themeSource = theme
      if (theme === 'system') return
      for (const page of pages) {
        await page.until(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === 'dark'}`, `the ${theme} theme`)
        await page.settled()
      }
    },
    /**
     * The window's page at this size (its content, in CSS pixels at its zoom), laid out again and at rest: what a
     * screenshot after a resize shows.
     */
    async resize(width, height) {
      win().setContentSize(width, height)
      const zoom = t.contents().getZoomFactor()
      await t.until(`Math.abs(innerWidth - ${width / zoom}) < 1 && Math.abs(innerHeight - ${height / zoom}) < 1`, `the window at ${width}×${height}`)
      await t.settled()
    },
    /** The page zoomed by `factor`, laid out again and at rest. */
    async zoom(factor) {
      const [width] = win().getContentSize()
      t.contents().setZoomFactor(factor)
      await t.until(`Math.abs(innerWidth - ${width / factor}) < 1`, `the page zoomed to ${factor}`)
      await t.settled()
    },
    /**
     * The window's buttons, which aren't in a screenshot of the page: stand-ins (#lights) drawn where the system puts
     * them (trafficLightPosition, 12pt each, 20pt apart).
     */
    lights: () => t.run(`(() => {
      if (document.getElementById('lights')) return
      const lights = document.createElement('div')
      lights.id = 'lights'
      lights.style.cssText = 'position: fixed; z-index: 99; top: 18px; left: 18px; display: flex; gap: 8px; pointer-events: none'
      for (const colour of ['#ff5f57', '#febc2e', '#28c840']) lights.append(Object.assign(document.createElement('span'), { style: \`width: 12px; height: 12px; border-radius: 50%; background: \${colour}\` }))
      document.body.append(lights)
    })()`),
    /** Screenshots in light, then dark, as `<file>-light` and `<file>-dark`; `before` runs in the page first each time. */
    async both(file, before) {
      if (!shots) return
      for (const theme of ['light', 'dark']) {
        await t.theme(theme)
        if (before) await t.run(before)
        await t.shot(`${file}-${theme}`)
      }
      nativeTheme.themeSource = 'system'
    },
  })

  // Past first run, unless the run is about it (`firstRun`): a fresh home's first window opens on setup (Setup.tsx).
  if (!options.firstRun && process.env.SUPEREGO_HOME) pastFirstRun(process.env.SUPEREGO_HOME)
  const started = Date.now()
  await import(main)
  // Not awaited: Electron's `ready` comes only once the entry module (the script awaiting this) has run.
  void (async () => {
    await app.whenReady()
    if (connected) await t.until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'this machine connected', 60_000)
    if (size) await t.resize(...size)
    await body(t)
    if (ended) return
    ended = true
    clearTimeout(deadline)
    console.log(`${name}: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`)
    if (options.onPass) return options.onPass()
    // run-app.sh stops an app that hangs on its way out once this is there.
    if (process.env.SUPEREGO_HOME) writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
    app.exit(0)
  })().catch((error) => fail(error instanceof Failure ? error.message : error?.stack ?? String(error)))
}

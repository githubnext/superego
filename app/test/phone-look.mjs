// The phone's look, for tuning it (run by `test/look.sh <dir> phone-look`): the web build in a browser window made an
// iPhone's (402×874 CSS px at 3×, a finger, the status bar's and home indicator's safe areas), paired by Web access to
// this home. The drawer open (its rows' states dressed on their way to the phone: one working on a branch of its own,
// one asking, one done, the rest quiet at their times); its search in use, empty, with matches and with none, the keyboard up; a thread with markdown, a code block and tool calls, words in the composer; the same with
// the keyboard up; the thread's menu; the New thread sheet; the Diff pane's tab; Settings' list and a page of it. In light and dark, into
// $SUPEREGO_SHOWCASE_OUT as drawer-, swipe- (a row swiped open), swipe-pin-, swipe-full- (held most of the way across), search-empty-, search-results-, search-none-, thread-, answer-, keyboard-, menu-, new-thread-, pane-, settings- and settings-page-<light|dark>.png.
import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'

// iPhone 16 Pro / 17: its screen in points, its scale, and what the status bar (with the Dynamic Island) and the home
// indicator keep clear.
const PHONE = { width: 402, height: 874, scale: 3, top: 62, bottom: 34 }
// The keyboard's height on it (English, with the predictive bar), in points.
const KEYBOARD = 336

await openApp({ name: 'phone-look', timeout: 300_000 }, async (t) => {
  const { run, until } = t
  const step = (what) => console.log(`phone-look: ${what}`)
  step('the window')
  await until(`Boolean(document.querySelector('.app__empty'))`, 'the window')
  step('threads')
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const state = (id) => `window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state)`
  const turnOn = async (id, text) => {
    await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(text)} })`)
    await until(`${state(id)}.then((s) => s === 'done' || s === 'error')`, `answer in ${id}`)
  }
  const ids = []
  for (const thread of threads.slice(0, 2)) {
    const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)} })`)
    ids.push(id)
    await turnOn(id, thread.prompt)
    for (const text of thread.followUps) await turnOn(id, text)
  }
  for (const title of ['Group spending by category', 'Retry the bank sync with backoff', 'Reconcile the ledger against the bank’s monthly CSV statements']) {
    await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: ${JSON.stringify(title)} })`)
  }
  // One put away, for the drawer's search to find among the archived.
  const put = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Import the bank’s CSV export' })`)
  await run(`window.superego.call('local', 'thread.archive', { thread: '${put.id}' })`)
  const id = ids[0]
  for (const each of ids) await run(`window.superego.call('local', 'thread.seen', { thread: '${each}' })`)
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'diff' })`)
  const title = await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').title)`)

  step('the phone')
  // The phone: a browser window on this home's web access, paired.
  const port = 20000 + Math.floor(Math.random() * 20000)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.port', value: ${port} })`)
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'local' })`)
  const { link } = await until(`window.superego.call('local', 'web.pair', {}).catch(() => undefined)`, 'a pairing link')
  const phone = new BrowserWindow({ show: false, width: PHONE.width, height: PHONE.height, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const p = t.on(() => phone.webContents, 'phone')
  await phone.loadURL('about:blank')
  const cdp = phone.webContents.debugger
  cdp.attach()
  const metrics = (height) => cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: PHONE.width, height, deviceScaleFactor: PHONE.scale, mobile: true })
  await metrics(PHONE.height)
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' })
  await cdp.sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: { top: PHONE.top, bottom: PHONE.bottom, left: 0, right: 0 } })
  // The threads' states as the drawer shows them, by title, dressed in every message from the daemon (a scripted model
  // can't hold a thread working or asking while the shots are taken).
  await cdp.sendCommand('Page.enable')
  await cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const m = 60000, now = Date.now()
    const DRESS = {
      'Retry the bank sync with backoff': { status: { state: 'working' }, facts: { worktrees: { branch: 'retry-backoff', path: '/home/me/ledger-retry-backoff' } } },
      'Group spending by category': { status: { state: 'blocked', kind: 'question', msg: 'Monthly or weekly?' }, ago: 3 * m },
      'Reconcile the ledger against the bank’s monthly CSV statements': { status: { state: 'done', msg: 'Reconciled' }, ago: 12 * m },
      'Add a --dry-run flag to the import command': { ago: 95 * m },
    }
    const dress = (value) => {
      if (Array.isArray(value)) return value.map((each) => {
        const as = each && typeof each === 'object' && typeof each.title === 'string' && each.status && DRESS[each.title]
        if (!as) return dress(each)
        const { ago = 0, facts, ...rest } = as
        return { ...each, ...rest, facts: { ...each.facts, ...facts }, activeAt: now - ago }
      })
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, dress(each)]))
      return value
    }
    const Native = WebSocket
    window.WebSocket = class extends Native {
      set onmessage(listen) {
        super.onmessage = (message) => {
          let data = message.data
          try { data = JSON.stringify(dress(JSON.parse(data))) } catch { /* not JSON: passed on as it came */ }
          listen({ data })
        }
      }
    }
  })()` })
  await phone.loadURL(link)
  await p.until(`window.superego?.web === true && matchMedia('(pointer: coarse)').matches && Boolean(document.querySelector('.app.is-narrow'))`, 'the phone’s page, narrow, under a finger')
  // The status bar and the home indicator aren't in a screenshot of the page: stand-ins where the system draws them,
  // in the text's colour, over everything.
  const chrome = `(() => {
    if (document.getElementById('phone-chrome')) return
    const host = document.createElement('div')
    host.id = 'phone-chrome'
    host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; color: CanvasText; font: 600 17px -apple-system, system-ui, sans-serif'
    host.innerHTML = '<span style="position: absolute; top: 21px; left: 52px">9:41</span>'
      + '<span style="position: absolute; top: 11px; left: 50%; width: 126px; height: 37px; margin-left: -63px; border-radius: 19px; background: #000"></span>'
      + '<span style="position: absolute; top: 23px; right: 32px; width: 27px; height: 13px; border-radius: 4px; border: 1px solid currentColor; opacity: .9"><i style="position: absolute; inset: 1.5px 5px 1.5px 1.5px; border-radius: 2px; background: currentColor"></i></span>'
      + '<span id="phone-home" style="position: absolute; bottom: 8px; left: 50%; width: 140px; height: 5px; margin-left: -70px; border-radius: 3px; background: currentColor"></span>'
    document.body.append(host)
  })()`
  const shot = async (name) => {
    step(name)
    await p.run(chrome)
    await p.settled()
    // A hidden window draws a frame only now and then: asked for one and given none in a while, asked again for one
    // beyond the viewport, which makes it draw.
    let data
    for (const params of [{}, { captureBeyondViewport: true }, {}, { captureBeyondViewport: true }]) {
      data = await Promise.race([cdp.sendCommand('Page.captureScreenshot', { format: 'png', ...params }).then((r) => r.data), new Promise((resolve) => setTimeout(resolve, 3000))])
      if (data) break
    }
    if (!data) t.fail(`${name}: no frame to take`)
    writeFileSync(`${process.env.SUPEREGO_SHOWCASE_OUT}/${name}.png`, Buffer.from(data, 'base64'))
  }
  const both = async (name, before) => {
    for (const appearance of ['light', 'dark']) {
      await t.theme(appearance, [p])
      if (before) await p.run(before)
      await shot(`${name}-${appearance}`)
    }
  }
  const tap = (selector, text) => p.click(selector, text)

  // The drawer: the threads.
  await p.until(`Boolean(document.querySelector('.app__mobilebar'))`, 'the bar')
  await p.run(`document.querySelector('.app__mobilebar button').click()`)
  await p.until(`[...document.querySelectorAll('.app__sidebar .superego-list-item')].some((li) => li.textContent.includes('Group spending'))`, 'the drawer, its threads')
  await both('drawer')
  // Swipe actions, by a finger: a row swiped left and let go, open on More and Archive; another swiped right, open on
  // Pin; one swiped most of the way across and held, Archive stretched over it (let go back where it began). Touch
  // pointer events dispatched in the page: a hidden window takes real touches only as it draws, slower than a long press.
  const drag = (text, by, { from = 0.5, release = true } = {}) => p.run(`(async () => {
    const li = [...document.querySelectorAll('.app__sidebar .superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(text)}))
    const box = li.getBoundingClientRect()
    const x = box.left + box.width * ${from}, y = box.top + box.height / 2
    const at = (type, clientX) => li.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientX, clientY: y }))
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    at('pointerdown', x)
    for (let i = 1; i <= 12; i++) { at('pointermove', x + ${by} * i / 12); await pause(16) }
    // Still a moment before letting go: no flick.
    await pause(120)
    at('pointermove', x + ${by})
    if (${release}) at('pointerup', x + ${by})
    await pause(600)
    // Held: let go of later back where it began (\`back\`).
    window.swipeBack = () => { at('pointermove', x); at('pointerup', x) }
  })()`)
  const tapHead = () => p.run(`(() => {
    const head = document.querySelector('.app__sidebar .threads__head')
    const box = head.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 8, isPrimary: true, clientX: box.left + 20, clientY: box.top + box.height / 2 }
    head.dispatchEvent(new PointerEvent('pointerdown', init))
    head.dispatchEvent(new PointerEvent('pointerup', init))
  })()`)
  await drag('Group spending', -120, { from: 0.8 })
  await p.until(`Boolean(document.querySelector('.threads-swipe.is-swiped .threads-swipe__actions--trailing'))`, 'a row swiped open on its trailing actions')
  await both('swipe')
  await drag('Retry the bank sync', 90, { from: 0.2 })
  await p.until(`document.querySelectorAll('.threads-swipe.is-swiped').length === 1 && Boolean(document.querySelector('.threads-swipe.is-swiped .threads-swipe__actions--leading'))`, 'a row swiped open on Pin, the other closed')
  await both('swipe-pin')
  await tapHead()
  await p.until(`!document.querySelector('.threads-swipe.is-swiped')`, 'the open row closed by a tap elsewhere')
  await drag('Group spending', -300, { from: 0.9, release: false })
  await p.until(`Boolean(document.querySelector('.threads-swipe__actions.is-armed'))`, 'Archive stretched')
  await both('swipe-full')
  await p.run(`window.swipeBack()`)
  await p.until(`!document.querySelector('.threads-swipe.is-swiped')`, 'the row back where it was')
  await new Promise((resolve) => setTimeout(resolve, 700))
  // Its search: focused with the keyboard up (the field where it was, not slid away), empty; then typed, with matches
  // (the archived among them); then with none.
  const field = `document.querySelector('.app__drawer .threads-search__input')`
  const fieldTop = () => p.run(`Math.round(${field}.getBoundingClientRect().top)`)
  const typeIn = (text) => `(() => {
    const input = ${field}
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`
  const before = await fieldTop()
  await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await p.run(`${field}.focus()`)
  await p.until(`Boolean(document.querySelector('.app__drawer .threads-search__cancel'))`, 'the search field in use')
  await metrics(PHONE.height - KEYBOARD)
  await p.until(`document.documentElement.hasAttribute('data-keyboard')`, 'the keyboard up over the drawer')
  const after = await fieldTop()
  if (after !== before) t.fail(`the search field moved with the keyboard up: ${before} → ${after}`)
  await p.run(`document.getElementById('phone-home')?.remove()`)
  await both('search-empty')
  await p.run(typeIn('bank'))
  await p.until(`document.querySelectorAll('.app__drawer .threads-found .superego-list-item').length >= 3`, 'the matches')
  await both('search-results')
  await p.run(typeIn('zebra'))
  await p.until(`Boolean(document.querySelector('.app__drawer .threads-found__none strong'))`, 'nothing found')
  await both('search-none')
  await p.run(`document.querySelector('.app__drawer .threads-search__cancel').click()`)
  await p.until(`!document.querySelector('.app__drawer .threads-search__cancel')`, 'the search put away')
  await cdp.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
  await metrics(PHONE.height)
  await p.until(`!document.documentElement.hasAttribute('data-keyboard')`, 'the keyboard down')
  await p.run(`document.getElementById('phone-chrome')?.remove()`)
  // A thread: a task opened with its tool calls (an edit, a command), the answer's code block under it; words in the composer.
  await p.run(`[...document.querySelectorAll('.app__sidebar .superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}.slice(0, 12))).click()`)
  await p.until(`!document.querySelector('.app__drawer') && document.querySelectorAll('.transcript .msg').length >= 2`, 'the thread')
  await p.run(`(() => { const task = [...document.querySelectorAll('details.task')].find((d) => d.textContent.includes('Fixing parseDate')); if (task) task.open = true })()`)
  await p.until(`[...document.querySelectorAll('details.task[open] .step')].length > 0`, 'the task’s steps')
  await p.run(`[...document.querySelectorAll('details.task[open] details.step:not(.step--thinking):not([open])')].forEach((d) => { d.open = true })`)
  const view = `(() => {
    const edit = [...document.querySelectorAll('details.task[open] details.step')].find((d) => d.textContent.includes('Edited'))
    edit?.scrollIntoView({ block: 'start' })
    edit?.closest('.thread__scroll')?.scrollBy(0, -120)
    const textarea = document.querySelector('.composer textarea')
    if (textarea && !textarea.value) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Now write the migration for the rows already imported')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.activeElement?.blur()
  })()`
  await both('thread', view)
  // The answer's end: markdown and its code block.
  await both('answer', `document.querySelector('.thread__scroll').scrollTop = 1e6`)
  // The keyboard up: the page shrunk to what's above it (viewport.ts), a stand-in for the keyboard under it.
  await metrics(PHONE.height - KEYBOARD)
  await p.until(`document.documentElement.hasAttribute('data-keyboard')`, 'the page above the keyboard')
  await both('keyboard', `(() => {
    document.getElementById('phone-home')?.remove()
    document.querySelector('.thread__scroll').scrollTop = 1e6
  })()`)
  await metrics(PHONE.height)
  await p.until(`!document.documentElement.hasAttribute('data-keyboard')`, 'the keyboard down')
  await p.run(`document.getElementById('phone-chrome')?.remove()`)
  // The thread's menu, from its title.
  await tap('button.app__mobiletitle')
  await p.until(`!!document.querySelector('.thread-sheet')`, 'the thread’s menu')
  await both('menu')
  await p.run(`document.querySelector('.app__scrim--sheet').click()`)
  await p.until(`!document.querySelector('.thread-sheet')`, 'the menu closed')
  // New thread.
  await p.run(`document.querySelector('.app__mobilebar [aria-label="New thread"]').click()`)
  await p.until(`Boolean(document.querySelector('.new-thread .composer textarea'))`, 'the New thread sheet')
  await both('new-thread', `document.activeElement?.blur()`)
  await p.run(`document.querySelector('.new-thread')?.closest('.superego-dialog')?.querySelector('[aria-label="Close"]')?.click()`)
  await p.until(`!document.querySelector('.new-thread')`, 'New thread closed')
  // The Diff pane, from its tab.
  await p.run(`[...document.querySelectorAll('.strip__tab')].find((tab) => tab.dataset.pane)?.click()`)
  await p.until(`!!document.querySelector('.git-changes, .diff-file')`, 'the Diff pane')
  await both('pane')
  await p.run(`document.querySelector('.strip__tab:not([data-pane])')?.click()`)
  // Settings: from the drawer's foot.
  await p.run(`document.querySelector('.app__mobilebar button').click()`)
  await p.until(`!!document.querySelector('.app__drawer .app__settings')`, 'the drawer')
  await p.run(`document.querySelector('.app__drawer .app__settings').click()`)
  await p.until(`!!document.querySelector('.settings__groups')`, 'Settings’ list')
  await both('settings')
  // A page of it: General's.
  await tap('.settings__row', 'General')
  await p.until(`!!document.querySelector('.settings--list .settings-section .setting')`, 'Settings → General')
  await both('settings-page')
  phone.destroy()
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'off' })`)
})

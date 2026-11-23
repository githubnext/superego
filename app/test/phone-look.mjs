// The phone's look, for tuning it (run by `test/look.sh <dir> phone-look`): the web build in a browser window made an
// iPhone's (402×874 CSS px at 3×, a finger, the status bar's and home indicator's safe areas), paired by Web access to
// this home. The drawer open; a thread with markdown, a code block and tool calls, words in the composer; the same with
// the keyboard up; the thread's menu; the New thread sheet; the Diff pane's tab; Settings. In light and dark, into
// $SUPEREGO_SHOWCASE_OUT as drawer-, thread-, keyboard-, menu-, new-thread-, pane- and settings-<light|dark>.png.
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
  for (const title of ['Group spending by category', 'Retry the bank sync with backoff']) {
    await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: ${JSON.stringify(title)} })`)
  }
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
    // Beyond the viewport, which makes a frame: a hidden window draws none of its own to take.
    const { data } = await cdp.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
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
  await p.run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
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
  await p.until(`!!document.querySelector('.settings__nav')`, 'Settings')
  await both('settings')
  phone.destroy()
  await run(`window.superego.call('local', 'settings.set', { key: 'web.access', value: 'off' })`)
})

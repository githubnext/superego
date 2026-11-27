// Screenshots of Processes (run by `test/look.sh <dir> processes`): the folder's dev server started from the window, and
// a thread that started the tests and a build, woken by the build failing (its report in the transcript, the chip saying
// Failed, the row's mark); the Processes pane on the failed build's output, on a process gone with a restart of the
// machine, on the dev server, and the chip's menu; then a phone: the thread's sheet with the chip's rows, and the pane
// full screen. Light and dark, into $SUPEREGO_SHOWCASE_OUT as processes-report-, processes-pane-, processes-lost-,
// processes-dev-, processes-menu-, processes-phone-sheet- and processes-phone-pane-<light|dark>.png.
import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { openApp } from './harness.mjs'

const PHONE = { width: 402, height: 874, scale: 3, top: 62, bottom: 34 }

await openApp({ name: 'processes', timeout: 300_000 }, async (t) => {
  const { run, until } = t
  const step = (what) => console.log(`processes: ${what}`)
  await t.resize(1300, 820)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const call = (method, params) => run(`window.superego.call('local', ${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  const list = (id) => call('processes.list', { thread: id })

  step('a thread starting the tests and a build, the folder’s dev server up')
  const { id } = await call('thread.start', { cwd: project, title: 'Fix the import’s month totals' })
  // The folder's dev server, started from the window: shared by the threads there.
  await call('action.run', { id: 'processes.start', params: { folder: project, name: 'dev', command: 'npm run dev', ready: 'ready in', notify: 'failure' } })
  await until(`window.superego.call('local', 'processes.list', { thread: '${id}' }).then((list) => list.some((p) => p.name === 'dev' && p.state === 'running'))`, 'the dev server ready')
  await call('thread.send', { thread: id, text: 'Run the tests in watch mode and a full build while I look at the import’s types.' })
  // Its two turns, then the report waking it and its two more.
  await until(`window.superego.call('local', 'processes.list', { thread: '${id}' }).then((list) => list.some((p) => p.state === 'failed'))`, 'the build failed', 60_000)
  const answered = `window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}')?.status).then((s) => s?.state === 'done' && /no entries in the month/.test(s.msg ?? ''))`
  await until(answered, 'woken by the report, and answered', 60_000)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('month totals'))?.click()`)
  await until(`!!document.querySelector('.processes-report') && !!document.querySelector('.processes-chip.is-failed')`, 'the report and the chip')
  await until(`!!document.querySelector('.processes-badge')`, 'the row’s mark')
  await t.lights()
  await t.both('processes-report', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)

  step('the pane')
  const build = (await list(id)).find((p) => p.command === 'npm run build')
  await call('pane.open', { thread: id, kind: 'processes', params: { id: build.id } })
  await until(`[...document.querySelectorAll('.processes-line')].some((l) => l.textContent.includes('TS2322'))`, 'the build’s output')
  await until(`document.querySelectorAll('.processes-row').length >= 3`, 'its list')
  await t.both('processes-pane', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)

  step('lost')
  await run(`[...document.querySelectorAll('.processes-row')].find((r) => r.textContent.includes('storybook'))?.click()`)
  await until(`!!document.querySelector('.processes-row.is-selected.is-lost') && [...document.querySelectorAll('.processes-line')].some((l) => l.textContent.includes('gone with a restart'))`, 'the lost one selected')
  await t.both('processes-lost')

  step('the dev server')
  await run(`[...document.querySelectorAll('.processes-row')].find((r) => r.title === 'npm run dev')?.click()`)
  await until(`[...document.querySelectorAll('.processes-line')].some((l) => l.textContent.includes('localhost:5173'))`, 'the dev server’s output')
  await t.both('processes-dev')

  step('the chip’s menu')
  await run(`document.querySelector('.processes-chip')?.closest('button')?.click()`)
  await until(`[...document.querySelectorAll('.superego-menu__item')].some((i) => i.textContent.includes('Show processes'))`, 'the chip’s menu')
  await t.both('processes-menu')
  await run(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  step('the phone')
  const port = 20000 + Math.floor(Math.random() * 20000)
  await call('settings.set', { key: 'web.port', value: port })
  await call('settings.set', { key: 'web.access', value: 'local' })
  const { link } = await until(`window.superego.call('local', 'web.pair', {}).catch(() => undefined)`, 'a pairing link')
  const phone = new BrowserWindow({ show: false, width: PHONE.width, height: PHONE.height, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const p = t.on(() => phone.webContents, 'phone')
  await phone.loadURL('about:blank')
  const cdp = phone.webContents.debugger
  cdp.attach()
  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', { width: PHONE.width, height: PHONE.height, deviceScaleFactor: PHONE.scale, mobile: true })
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.sendCommand('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' })
  await cdp.sendCommand('Emulation.setSafeAreaInsetsOverride', { insets: { top: PHONE.top, bottom: PHONE.bottom, left: 0, right: 0 } })
  await cdp.sendCommand('Page.enable')
  await phone.loadURL(link)
  await p.until(`window.superego?.web === true && Boolean(document.querySelector('.app.is-narrow'))`, 'the phone’s page')
  const shot = async (name) => {
    await p.settled()
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
  await p.until(`Boolean(document.querySelector('.app__mobilebar'))`, 'the bar')
  await p.run(`document.querySelector('.app__mobilebar button').click()`)
  await p.until(`[...document.querySelectorAll('.app__sidebar .superego-list-item')].some((li) => li.textContent.includes('month totals'))`, 'the thread in the drawer')
  await p.run(`[...document.querySelectorAll('.app__sidebar .superego-list-item')].find((li) => li.textContent.includes('month totals')).click()`)
  await p.until(`!document.querySelector('.app__drawer') && document.querySelectorAll('.transcript .msg').length >= 2`, 'the thread')
  // The thread's sheet, from its title: the chip's row, and its menu's rows under it.
  await p.run(`document.querySelector('button.app__mobiletitle').click()`)
  await p.until(`!!document.querySelector('.thread-sheet .processes-chip')`, 'the chip in the thread’s sheet')
  await both('processes-phone-sheet')
  await p.run(`document.querySelector('.app__scrim--sheet')?.click()`)
  await p.until(`!document.querySelector('.thread-sheet')`, 'the sheet closed')
  // The pane, from its tab.
  await p.run(`[...document.querySelectorAll('.strip__tab')].find((tab) => tab.textContent.includes('Processes'))?.click()`)
  await p.until(`document.querySelectorAll('.processes-row').length >= 3`, 'the pane full screen')
  await both('processes-phone-pane')
})

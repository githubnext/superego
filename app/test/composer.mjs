// Screenshots of the composer and what's around it (run by `test/look.sh <dir> composer`): idle with suggestions, a
// file waiting, the agent working with messages queued and one typed to steer, a question waiting, archived, and the
// narrow layout; light and dark. Into $SUPEREGO_SHOWCASE_OUT.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { writeFileSync } from 'node:fs'

// Its own recorded agent, in place of the showcase's, written before the daemon starts and reads it.
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const turn = (content) => ({ content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' })
const turns = [
  // Working: a few steps, then one that runs long.
  turn([{ type: 'text', text: 'Searching for where the focus is set.' }, call('w1', 'bash', { command: 'grep -rn Date src | head -5' }), call('w2', 'read', { path: 'package.json' })]),
  turn([{ type: 'text', text: 'Running the whole suite now.' }, call('w3', 'bash', { command: 'sleep 600' })]),
  // A question.
  turn([call('q1', 'ask_user', { question: 'Which export should the importer read first?', options: ['Danske', 'Nordea'] })]),
]
// The echo model by default (suggestions come from it: it echoes them back), the recording offered beside it.
process.env.SUPEREGO_REPLAY = process.env.SUPEREGO_MODEL.slice('replay:'.length)
process.env.SUPEREGO_MODEL = 'faux'
writeFileSync(process.env.SUPEREGO_REPLAY, turns.map((message) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', ...message } })).join('\n') + '\n')

const fail = (message) => { console.error(`composer: FAIL ${message}`); app.exit(1) }
process.on('uncaughtException', (error) => fail(`uncaught: ${error.stack ?? error}`))
app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => { if (event.level === 'error') console.error('renderer:', event.message) }))
setTimeout(() => fail('timed out'), 180_000)

await import('../out/main/main.js')
void (async () => {
  await app.whenReady()
  const win = () => BrowserWindow.getAllWindows()[0]
  const run = (js) => win().webContents.executeJavaScript(js)
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (js, label, ms = 30_000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (win() && !win().webContents.isLoading()) { const value = await run(js).catch(() => undefined); if (value) return value }
      await sleep(100)
    }
    await run(`document.querySelector('.thread')?.innerText.slice(-600)`).then((t) => console.error(t), () => {})
    writeFileSync(`${process.env.SUPEREGO_SHOWCASE_OUT}/fail.png`, (await win().webContents.capturePage()).toPNG())
    fail(`waiting for ${label}`)
    throw new Error(label)
  }
  await until(`window.superego.machines().then((list) => list.find((m) => m.id === 'local')?.state === 'connected')`, 'local machine')
  const [width, height] = (process.env.LOOK_SIZE ?? '1100x760').split('x').map(Number)
  win().setContentSize(width, height)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const out = process.env.SUPEREGO_SHOWCASE_OUT
  const shot = async (name) => writeFileSync(`${out}/${name}.png`, (await win().webContents.capturePage()).toPNG())
  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      await run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
      await sleep(200)
      await shot(`${name}-${theme}`)
    }
  }
  // The phone layout: the page laid out at a phone's width, as a browser on one would (the window can't get that narrow).
  const emulation = win().webContents.debugger
  if (!emulation.isAttached()) emulation.attach()
  const phone = async (name) => {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      await sleep(400)
      await emulation.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 2, mobile: true })
      await sleep(500)
      await run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
      await sleep(200)
      await shot(`${name}-${theme}`)
      await emulation.sendCommand('Emulation.clearDeviceMetricsOverride')
      await sleep(300)
    }
  }
  const state = (id) => `window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state)`
  const create = (title) => run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: ${JSON.stringify(title)} }).then((t) => t.id)`)
  const submit = (id, text, whenBusy) => run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(text)}${whenBusy ? `, whenBusy: '${whenBusy}'` : ''} })`)
  const open = (title) => until(`(() => { const li = [...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)})); li?.click(); return Boolean(li) && document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)} })()`, `${title} shown`)
  const type = (text) => run(`(() => {
    const ta = document.querySelector('.composer textarea')
    ta.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  // Idle, with what to send next offered.
  const idle = await create('Dates land a day early')
  await submit(idle, 'What next? ["Run the tests", "Commit this", "Check the Nordea export too"]')
  await until(`${state(idle)}.then((s) => s === 'done')`, 'idle thread answered')
  await open('Dates land a day early')
  await until(`document.querySelectorAll('.suggestions__item').length === 3`, 'suggestions')
  await both('idle-suggestions')
  // A file waiting to go, with words typed.
  await run(`(() => {
    const input = document.querySelector('.dock input[type=file]')
    const files = new DataTransfer()
    files.items.add(new File(['# plan\\n'], 'plan.md', { type: 'text/markdown' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`Boolean(document.querySelector('.composer__files .attachment'))`, 'file waiting')
  await type('Also read this plan')
  await both('idle-file')
  await type('')
  await run(`document.querySelector('.attachment__remove')?.click()`)

  await run(`window.superego.call('local', 'settings.set', { key: 'agent.model', value: 'replay/replay' })`)
  // Working, a follow-up queued (to send now), a steer waiting for the step, and words typed to steer with.
  const working = await create('Focus ring disappears')
  await submit(working, 'The focus ring disappears when a pane opens beside. Find out why and fix it')
  await until(`window.superego.call('local', 'thread.list', {}).then(async (list) => list.find((s) => s.id === '${working}')?.status.state === 'working')`, 'working')
  await open('Focus ring disappears')
  await until(`document.querySelector('.transcript')?.textContent.includes('Running the whole suite')`, 'long step running')
  await submit(working, 'Then run the smoke test on main', 'followUp')
  await submit(working, 'Leave the e2e suite out of it', 'steer')
  await until(`document.querySelectorAll('.queued-row').length === 2`, 'a follow-up and a steer waiting')
  await sleep(500)
  await type('also check split panes, not just beside')
  await both('working-queued')
  const working1 = await run(`document.querySelector('.transcript__working')?.textContent`)
  await sleep(2500)
  console.log('status line:', working1, '→', await run(`document.querySelector('.transcript__working')?.textContent`))
  await phone('working-queued-narrow')
  await type('')
  await sleep(300)
  await both('working')

  // A question waiting for an answer.
  const asking = await create('Pick an export')
  await submit(asking, 'Which export first?')
  await open('Pick an export')
  await until(`Boolean(document.querySelector('.ask-user'))`, 'question')
  await both('question')
  await phone('question-narrow')

  // Archived: read only, with the way back.
  await run(`window.superego.call('local', 'thread.archive', { thread: '${idle}' })`)
  await run(`window.superego.call('local', 'thread.stop', { thread: '${working}' })`)
  await run(`window.superego.call('local', 'thread.stop', { thread: '${asking}' })`)
  await run(`document.querySelector('.threads-archived button, .threads-archived summary')?.click()`)
  await until(`(() => { const li = [...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Dates land a day early')); li?.click(); return Boolean(li) && Boolean(document.querySelector('.titlebar__archived')) })()`, 'archived thread shown')
  await both('archived')
  await phone('archived-narrow')

  console.log(`composer: done in ${out}`)
  writeFileSync(`${process.env.SUPEREGO_HOME}/passed`, '')
  app.exit(0)
})()

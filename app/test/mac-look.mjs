// The window's look, for tuning it (run by `test/look.sh <dir> mac-look`): threads in the sidebar, one shown with
// markdown, a code block and tool calls, the Diff pane beside it and words in the composer; a thread's menu open; and
// the sidebar hidden (in a narrow window too), full screen; Settings, in a narrow window too. In light and dark, into $SUPEREGO_SHOWCASE_OUT as
// main-, hidden-, hidden-narrow-, fullscreen-hidden-, fullscreen-main-, menu-, settings- and settings-narrow-<light|dark>.png;
// close-ups of the top left corner and the title bar's row as main-, hidden- and fullscreen-…-corner- and -row-<light|dark>.png.
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'

await openApp({ name: 'mac-look', timeout: 300_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1440, 960)
  await until(`Boolean(document.querySelector('.app__empty'))`, 'the window')
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
  const title = await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}').title)`)
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}.slice(0, 12)))?.click()`)
  await until(`document.querySelectorAll('.transcript .msg').length >= 2`, 'thread shown')
  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'diff' })`)
  await until(`!!document.querySelector('.git-changes, .diff-file')`, 'changes')
  // A task opened, its tool calls (an edit, a command) and their output shown, and the answer with its code block under it.
  await run(`(() => { const task = [...document.querySelectorAll('details.task')].find((d) => d.textContent.includes('Fixing parseDate')); task.open = true })()`)
  await until(`[...document.querySelectorAll('details.task[open] .step')].length > 0`, 'the task’s steps')
  await run(`[...document.querySelectorAll('details.task[open] details.step:not(.step--thinking):not([open])')].forEach((d) => { d.open = true })`)
  await t.settled()
  const view = `(() => {
    const edit = [...document.querySelectorAll('details.task[open] details.step')].find((d) => d.textContent.includes('Edited'))
    edit?.scrollIntoView({ block: 'start' })
    edit?.closest('.thread__scroll')?.scrollBy(0, -24)
    const textarea = document.querySelector('.composer textarea')
    if (textarea && !textarea.value) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Now write the migration for the rows already imported')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.activeElement?.blur()
  })()`
  // Close-ups (`close`): the top left corner, the panel's top beside the sheet's; the title bar's row, the window's
  // buttons to the crumb's end.
  const corner = `({ getBoundingClientRect: () => new DOMRect(0, 0, 360, 140) })`
  const row = `({ getBoundingClientRect: () => new DOMRect(0, 0, Math.min(innerWidth, document.querySelector('.titlebar__crumb').getBoundingClientRect().right + 16), document.querySelector('.app__titlebar').getBoundingClientRect().bottom) })`
  const both = async (name, close = false) => {
    for (const appearance of ['light', 'dark']) {
      await t.theme(appearance)
      await run(view)
      await t.settled()
      await t.shot(`${name}-${appearance}`)
      if (close) {
        await t.shot(`${name}-corner-${appearance}`, corner)
        await t.shot(`${name}-row-${appearance}`, row)
      }
    }
  }
  // The window's buttons, drawn in, and checked to sit clear of the panel's corner; the title bar's row on their line.
  await t.lights()
  const panel = `(() => { const s = getComputedStyle(document.querySelector('.app'), '::before'); return { top: parseFloat(s.top), right: parseFloat(s.left) + parseFloat(s.width) } })()`
  const lights = await run(`(() => { const r = document.getElementById('lights').getBoundingClientRect(); return { right: r.right, bottom: r.bottom } })()`)
  const clear = async (what) => {
    const { top, right } = await run(panel)
    const history = await run(`document.querySelector('.app__history').getBoundingClientRect().left`)
    // Inside the panel (with room around them), or above it; and back and forward past them.
    if (!(right >= lights.right + 12 || top >= lights.bottom + 8)) t.fail(`${what}: the window's buttons run over the panel's corner (its top ${top}, right ${right})`)
    if (history < lights.right) t.fail(`${what}: back and forward under the window's buttons (at ${history})`)
    await t.titleRowAligned(what)
  }
  // Folded, the panel's top in line with the sheet's beside it.
  const level = async (what) => {
    const { top } = await run(panel)
    const sheet = await run(`document.querySelector('.panes__column').getBoundingClientRect().top`)
    if (Math.abs(top - sheet) > 0.5) t.fail(`${what}: the panel's top at ${top}, the sheet's at ${sheet}`)
  }
  const fold = async (folded) => {
    t.key('/', [process.platform === 'darwin' ? 'meta' : 'control'])
    await until(`${folded ? '!' : '!!'}document.querySelector('.app__sidebar')`, folded ? 'the sidebar hidden' : 'the sidebar back')
  }
  await clear('the sidebar open')
  await both('main', true)
  // The sidebar hidden: the rail alone in the panel, under the title bar.
  await fold(true)
  await clear('the sidebar folded')
  await level('the sidebar folded')
  await both('hidden', true)
  // A narrow window, folded.
  await t.resize(780, 700)
  await clear('narrow, folded')
  await level('narrow, folded')
  await both('hidden-narrow')
  await t.resize(1440, 960)
  // Full screen (said as the system does; a headless window doesn't go): no buttons, so no room kept for them.
  await run(`document.getElementById('lights').style.visibility = 'hidden'`)
  t.win().emit('enter-full-screen')
  await until(`document.querySelector('.app').classList.contains('is-full-screen')`, 'full screen')
  const start = await run(`parseFloat(getComputedStyle(document.querySelector('.app__titlebar')).paddingLeft)`)
  if (start > 20) t.fail(`full screen, the title bar still keeps ${start}px for the window's buttons`)
  await level('full screen, folded')
  await t.titleRowAligned('full screen')
  await both('fullscreen-hidden', true)
  await fold(false)
  await both('fullscreen-main', true)
  t.win().emit('leave-full-screen')
  await until(`!document.querySelector('.app').classList.contains('is-full-screen')`, 'out of full screen')
  await run(`document.getElementById('lights').style.visibility = ''`)
  // A thread's menu, from the sidebar.
  await run(`(() => { const li = [...document.querySelectorAll('.app__sidebar .superego-list-item')].find((l) => l.textContent.includes('Group spending')); const r = li.getBoundingClientRect()
    li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 60, clientY: r.top + r.height / 2 })) })()`)
  await until(`!!document.querySelector('.superego-menu')`, 'the thread’s menu')
  const at = await run(`(() => { const r = document.querySelectorAll('.superego-menu .superego-menu__item')[1].getBoundingClientRect(); return [Math.round(r.left + 30), Math.round(r.top + r.height / 2)] })()`)
  for (const dx of [0, 4]) t.contents().sendInputEvent({ type: 'mouseMove', x: at[0] + dx, y: at[1] })
  await until(`!!document.querySelector('.superego-menu__item[data-highlighted]')`, 'an item lit')
  await both('menu')
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  t.key('Escape', [])
  await until(`!document.querySelector('.superego-menu')`, 'the menu closed')
  // Settings → Appearance.
  await run(`document.querySelector('.app__settings').click()`)
  await t.click('.settings__nav button', 'Appearance')
  await until(`Boolean(document.querySelector('[data-key="app.theme.dark"]'))`, 'Settings → Appearance')
  await run(`document.querySelector('[data-key="app.theme.light"]').scrollIntoView({ block: 'center' })`)
  await both('settings')
  // A window too narrow for the sidebar beside a thread, not a phone's: Settings' list still down the side.
  await t.resize(700, 700)
  await until(`(() => { const [a, b] = document.querySelectorAll('.settings__nav [role="tab"]'); return b?.getBoundingClientRect().top > a.getBoundingClientRect().bottom - 1 })()`, 'Settings’ tabs down the side')
  const top = await run(`document.querySelector('.settings__nav [role="tab"]').getBoundingClientRect().top - document.querySelector('.settings__nav').getBoundingClientRect().top`)
  if (top > 20) t.fail(`narrow, Settings' first tab ${top}px down its list`)
  await both('settings-narrow')
})

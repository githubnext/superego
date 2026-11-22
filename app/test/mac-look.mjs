// The window's look, for tuning it (run by `test/look.sh <dir> mac-look`): threads in the sidebar, one shown with
// markdown, a code block and tool calls, the Diff pane beside it and words in the composer; a thread's menu open; and
// the sidebar hidden; Settings. In light and dark, into $SUPEREGO_SHOWCASE_OUT as main-, hidden-, menu- and
// settings-<light|dark>.png.
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
  const both = async (name) => {
    for (const appearance of ['light', 'dark']) {
      await t.theme(appearance)
      await run(view)
      await t.settled()
      await t.shot(`${name}-${appearance}`)
    }
  }
  await both('main')
  // The sidebar hidden: the rail alone in the panel.
  t.key('/', [process.platform === 'darwin' ? 'meta' : 'control'])
  await until(`!document.querySelector('.app__sidebar')`, 'the sidebar hidden')
  await both('hidden')
  t.key('/', [process.platform === 'darwin' ? 'meta' : 'control'])
  await until(`!!document.querySelector('.app__sidebar')`, 'the sidebar back')
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
  await until(`Boolean(document.querySelector('[data-key="app.theme.dark"]'))`, 'Settings → Appearance')
  await run(`document.querySelector('[data-key="app.theme.light"]').scrollIntoView({ block: 'center' })`)
  await both('settings')
})

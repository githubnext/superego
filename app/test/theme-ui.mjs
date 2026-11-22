// The whole window under every theme, matching it (run by `test/look.sh <dir> theme-ui`): threads in the sidebar, one shown with
// markdown, a code block and tool calls, the Diff pane beside it and words in the composer, under Superego's own and
// each built-in theme in its appearance. Screenshots into $SUPEREGO_SHOWCASE_OUT as <theme-id>.png (superego-light,
// superego-dark), and each one's window colours and their contrast logged.
import { openApp } from './harness.mjs'
import { threads } from './showcase/threads.mjs'
import { readFileSync } from 'node:fs'

// The built-ins, as builtin.ts lists them (the script runs as plain JavaScript).
const BUILTIN_THEMES = [...readFileSync(new URL('../../packages/ui/src/themes/builtin.ts', import.meta.url), 'utf8')
  .matchAll(/id: '([\w-]+)', name: '[^']+', appearance: '(light|dark)'/g)].map(([, id, appearance]) => ({ id, appearance }))

await openApp({ name: 'theme-ui', timeout: 300_000 }, async (t) => {
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
  const setting = (key, value) => run(`window.superego.call('app', 'app.settings.set', { key: '${key}', value: ${JSON.stringify(value)} })`)
  const css = `(() => { const s = getComputedStyle(document.documentElement); return ['bg', 'chrome', 'text', 'muted', 'border', 'line'].map((n) => n + ' ' + s.getPropertyValue('--superego-' + n).trim()).join(' | ') })()`
  const themes = [{ id: 'superego', appearance: 'light', shot: 'superego-light' }, { id: 'superego', appearance: 'dark', shot: 'superego-dark' },
    ...BUILTIN_THEMES.map((theme) => ({ id: theme.id, appearance: theme.appearance, shot: theme.id }))]
  // The window matching the theme (Settings → Appearance), unless THEME_UI_WINDOW=off.
  await setting('app.theme.window', process.env.THEME_UI_WINDOW !== 'off')
  for (const theme of themes) {
    await setting(theme.appearance === 'light' ? 'app.theme.light' : 'app.theme.dark', theme.id)
    await t.theme(theme.appearance)
    await run(view)
    await t.settled()
    await t.shot(theme.shot)
    console.log(`${theme.shot}: ${await run(css)}`)
  }
})

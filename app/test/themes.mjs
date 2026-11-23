// Themes for code and the terminal (run by `test/look.sh <dir> themes`): a thread with code and a diff in its answer,
// a file in the editor beside it, then the terminal, under Superego's own and four built-in pairs, light and dark; then
// Settings → Appearance's pickers and samples, with a theme imported. Screenshots into $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'

const PAIRS = [
  ['superego', 'superego', 'superego'],
  ['github', 'github-light', 'github-dark'],
  ['tokyo-night', 'tokyo-night-day', 'tokyo-night'],
  ['rose-pine', 'rose-pine-dawn', 'rose-pine'],
  ['zenbones', 'zenbones-light', 'zenbones-dark'],
]

await openApp({ name: 'themes', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1680, 900)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const setting = (key, value) => run(`window.superego.call('app', 'app.settings.set', { key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })`)
  const css = (name) => `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`
  const text = `(document.querySelector('.terminal-pane__screen')?.text?.() ?? '')`

  const { id } = await run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: 'Dates' })`)
  await run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: 'Rows land a day early. Fix the date parser.' })`)
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state === 'done')`, 'the answer')
  await until(`[...document.querySelectorAll('.superego-list-item')].some((li) => li.textContent.includes('Dates'))`, 'the thread listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Dates')).click()`)
  await until(`document.querySelectorAll('.transcript pre code span[class]').length > 4`, 'the answer’s code highlighted')

  await run(`window.superego.call('local', 'pane.open', { thread: '${id}', kind: 'editor', params: { path: 'src/cli.mjs' } })`)
  await until(`Boolean(document.querySelector('.cm-content .cm-line span[class]'))`, 'the file highlighted in the editor')
  // ⌃`: the thread's terminal, with something coloured in it.
  t.contents().sendInputEvent({ type: 'keyDown', keyCode: '`', modifiers: ['control'] })
  await until(`Boolean(document.querySelector('.terminal-pane__screen canvas')) && ${text}.length > 0`, 'the terminal and its prompt')
  await run(`(() => {
    const screen = document.querySelector('.terminal-pane__screen')
    for (const ch of ${JSON.stringify("clear; git log --oneline --decorate --color=always | head -3; ls -G; printf '\\033[31mred \\033[32mgreen \\033[33myellow \\033[34mblue \\033[35mmagenta \\033[36mcyan\\033[0m\\n'; echo done-$((40+2))\n")}) {
      const key = ch === '\\n' ? 'Enter' : ch
      screen.dispatchEvent(new KeyboardEvent('keydown', { key, code: ch === '\\n' ? 'Enter' : '', bubbles: true, cancelable: true }))
    }
  })()`)
  await until(`${text}.includes('done-42')`, 'the command’s output')

  const pairs = async (shot) => {
    for (const [name, light, dark] of PAIRS) {
      await setting('app.theme.light', light)
      await setting('app.theme.dark', dark)
      for (const appearance of ['light', 'dark']) {
        await t.theme(appearance)
        await t.settled()
        await t.shot(shot(name, appearance))
        console.log(`${shot(name, appearance)}: keyword ${await run(css('--superego-syntax-keyword'))}, terminal ${await run(css('--superego-terminal-bg'))}`)
      }
    }
  }
  // The code: the answer's, and the file's in the editor. The terminal pane is past the editor's, out of view.
  await t.click('.strip__tab', 'cli.mjs')
  await t.settled()
  await pairs((name, appearance) => `themes-${name}-${appearance}`)
  // The terminal beside the thread, once the editor is closed.
  await run(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}').panes.find((p) => p.kind === 'editor')).then((pane) => window.superego.call('local', 'pane.close', { thread: '${id}', pane: pane.id }))`)
  await until(`!document.querySelector('.cm-content') && Boolean(document.querySelector('.terminal-pane__screen canvas'))`, 'the editor closed, the terminal in view')
  await pairs((name, appearance) => `themes-${name}-terminal-${appearance}`)

  // Settings → Appearance: the pickers, their swatches, both samples, and an imported theme to remove.
  await run(`window.superego.call('app', 'app.themes.add', { theme: { name: 'Paper Ink', appearance: 'light', syntax: { keyword: '#7a3e9d', string: '#2f6f3e' }, terminal: { bg: '#fbfaf5' } } })`)
  await setting('app.theme.light', 'github-light')
  await setting('app.theme.dark', 'tokyo-night')
  t.key(',')
  await until(`Boolean(document.querySelector('.settings__nav'))`, 'Settings')
  await t.click('.settings__nav button', 'Appearance')
  await until(`Boolean(document.querySelector('[data-key="app.theme.dark"]')) && Boolean(document.querySelector('.theme-tools .setting'))`, 'Settings → Appearance with an imported theme')
  await run(`document.querySelector('[data-key="app.theme.light"]').scrollIntoView({ block: 'start' })`)
  await t.both('themes-settings')
})

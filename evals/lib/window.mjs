// The window checks' shared start, on the app's own harness (app/test/harness.mjs): the installed app, headless, on the
// run's daemon (its environment), its main loaded from `input.main`. Each check (pane-check.mjs, badge-check.mjs) runs as
// `Electron <check>.mjs` with its JSON input in EVAL_WINDOW_CHECK, writes its result to `input.out`, and quits. A check
// reports what it found rather than failing: a wait that runs out is a finding (`soon` gives undefined), and anything
// that goes wrong is kept in `result.errors`.
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { openApp } from '../../app/test/harness.mjs'

/**
 * Run `check(w)` once the window is connected, with the harness's helpers and the check's own: `input`, `result`,
 * `soon(js, ms)`, `call`, `row`, `show`, `registered`. Awaited at the top of the check's module.
 */
export async function windowCheck(check) {
  const input = JSON.parse(process.env.EVAL_WINDOW_CHECK)
  const result = { errors: [], console: [] }
  const finish = (code) => { writeFileSync(input.out, JSON.stringify(result, null, 2)); app.exit(code) }
  app.on('web-contents-created', (_e, contents) => contents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') result.console.push(String(event.message).slice(0, 500))
  }))
  await openApp({
    name: 'eval window check', main: input.main, timeout: 170_000, size: [1500, 1000], shots: input.shots,
    onFail: (message) => { result.errors.push(message); finish(1) },
    onPass: () => finish(0),
  }, async (t) => {
    /** What `until` gives, or undefined once `ms` is up: for a check, not finding it is the finding. */
    const soon = (js, ms = 20_000) => t.until(js, 'a finding', ms).catch(() => undefined)
    const call = (method, params) => t.call(method, params)
    /** The sidebar's row for a thread, by its title (an expression). */
    const row = (title) => `[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)}))`
    /** Show a thread, by its title in the sidebar; its profile's UI loads as it shows. */
    const show = async (title) => {
      await soon(`Boolean(${row(title)})`)
      await t.run(`${row(title)}?.click()`)
      await soon(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)}`)
      await t.settled()
    }
    /** What the window's extensions registered now (window.superegoRegistered: panes, slots and views, by owner). */
    const registered = () => t.run('window.superegoRegistered?.() ?? null')
    await check({ ...t, input, result, soon, call, row, show, registered })
  })
}

// The database-badge task's window check: the sidebar's row for each probe thread, and what it shows after the
// title (the `thread.badge` slot): before any thread is opened, then after one of the profile's threads is (its UI
// loads as it shows). Run by evals/tasks/db-badge.ts as `Electron badge-check.mjs`, with EVAL_WINDOW_CHECK set to its
// JSON input: { titles, open, shots, out, main }.
import { windowCheck } from './window.mjs'

await windowCheck(async (w) => {
  const { input, result, until, soon, run, row, show, shot, settled, registered } = w
  /** What each probe's row shows after its title: the badge's text, title and label, and whether one drew at all. */
  const badges = () => run(`(${JSON.stringify(input.titles)}).map((title) => {
    const li = ${row('__TITLE__').replace('"__TITLE__"', 'title')}
    const name = li?.querySelector('.threads__title')
    const after = name ? [...name.parentElement.children].filter((el) => el !== name) : []
    const describe = (el) => [el.textContent, el.getAttribute('title'), el.getAttribute('aria-label'), ...[...el.querySelectorAll('[title],[aria-label]')].flatMap((c) => [c.getAttribute('title'), c.getAttribute('aria-label')])].filter(Boolean).join(' / ')
    return { title, found: Boolean(li), badge: after.some((el) => !el.classList.contains('extension-failed') && (el.textContent.trim() || el.querySelector('svg,img') || el.matches('svg,img,[title],[aria-label]'))), failed: after.some((el) => el.classList.contains('extension-failed')), says: after.map(describe).join(' | ').slice(0, 200) }
  })`)
  result.steps = []
  const step = (what) => result.steps.push(`${what} ${Date.now() % 1_000_000}`)
  step('start')
  await soon(`Boolean(${row(input.titles[0])})`)
  step('rows')
  // Before any thread is opened, a profile's UI loads for its listed threads: a badge, if one draws, soon (none, after a
  // while, is the finding).
  const drawn = async () => (await badges()).some((b) => b.badge)
  await until(drawn, 'a badge before any thread is opened', 2000).catch(() => undefined)
  await settled()
  result.before = await badges()
  step('before')
  await show(input.open)
  step('shown')
  // Its profile's UI, loaded: a badge drawn from the thread's facts, then the rest at rest.
  await until(drawn, 'a badge once a thread is shown', 10_000).catch(() => undefined)
  await settled()
  result.after = await badges()
  step('after')
  result.slots = (await registered())?.slots?.['thread.badge'] ?? []
  result.screenshot = await shot(`${input.shots}/sidebar.png`, `document.querySelector('.superego-list-item')?.closest('section')?.parentElement`)
  step('shot')
})

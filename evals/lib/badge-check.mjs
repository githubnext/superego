// The database-badge task's window check: the sidebar's row for each probe thread, and what it shows after the
// title (the `thread.badge` slot): before any thread is opened, then after one of the profile's threads is (its UI
// loads as it shows). Run by evals/tasks/db-badge.ts as `Electron badge-check.mjs`, with EVAL_WINDOW_CHECK set to its
// JSON input: { titles, open, shots, out, main }.
import { openWindow } from './window.mjs'

// Not awaited at the top: Electron's `ready` comes only once the entry module has run.
void openWindow().then(async (w) => {
  if (!w) return
  const { input, result, finish, sleep, until, run, row, show, shoot, registered } = w
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
  await until(`Boolean(${row(input.titles[0])})`)
  step('rows')
  await sleep(2000)
  result.before = await badges()
  step('before')
  await show(input.open)
  step('shown')
  // Its profile's UI, loaded: give a badge time to draw from the thread's facts.
  for (let i = 0; i < 20; i++) { result.after = await badges(); if (result.after.some((b) => b.badge)) break; await sleep(500) }
  await sleep(1000)
  result.after = await badges()
  step('after')
  result.slots = (await registered())?.slots?.['thread.badge'] ?? []
  result.screenshot = await shoot(`${input.shots}/sidebar.png`, `document.querySelector('.superego-list-item')?.closest('section')?.parentElement`)
  step('shot')
  finish(0)
})

// Screenshots of schedules (run by `test/look.sh <dir> schedules`): a thread that opened a PR and scheduled a check of
// its CI every 30 minutes until green, and a reminder for the morning; the agent's `schedule` rows with their next
// times; the clock chip in its header and its popover, a paused schedule among them; Edit, and New schedule… with a
// calendar time and what it comes to; `/schedule` in the composer; the clock on its row and another thread's in the
// sidebar; a firing (Run now from the popover); a run missed while Superego wasn't running, fired once it's back, late;
// the reminder, a notice with no run; every schedule on the machine; and the phone's sheet. Light and dark, into
// $SUPEREGO_SHOWCASE_OUT.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

const PROMPT = "Open the PR and check CI every 30 min until it's green."
const TITLE = 'Land the bank-sync retries'

await openApp({ name: 'schedules', timeout: 300_000 }, async (t) => {
  const { run, until, call } = t
  await t.resize(1100, 720)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  /** A screenshot of part of the window (`element`, an expression), light then dark. */
  const bothOf = async (file, element) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await t.shot(`${file}-${theme}`, element)
    }
  }
  const settle = async (id) => {
    await until(`window.superego.call('local', 'thread.list', {}).then((list) => ['done', 'error', 'idle'].includes(list.find((t) => t.id === '${id}')?.status.state))`, 'the answer', 60_000)
    await call('thread.seen', { thread: id })
  }

  // Another thread with a schedule of its own, for the sidebar's marks.
  const other = await call('thread.start', { cwd: project, title: 'Nightly import health' })
  await call('schedules.add', { thread: other.id, when: 'every 6h', message: 'Look at the nightly import log.', label: 'Import health' })

  const { id } = await call('thread.start', { cwd: project, title: TITLE })
  await call('thread.send', { thread: id, text: PROMPT })
  await settle(id)
  await call('thread.send', { thread: id, text: "Thanks. Remind me at 9 tomorrow to review Mia's PR." })
  await settle(id)
  // One of the user's own, paused.
  const paused = await call('schedules.add', { thread: id, when: 'every 2h', message: 'Check the error rate on staging.', label: 'Check the error rate' })
  await call('schedules.pause', { id: paused.id })

  const row = (title) => `[...document.querySelectorAll('.threads-project .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row(TITLE)}?.querySelector('.schedules-clock'))`, 'the sidebar’s clock')
  await run(`${row(TITLE)}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(TITLE)}`, 'the thread shown')
  await until(`document.querySelectorAll('.transcript .row').length >= 2 && Boolean(document.querySelector('.schedules-times__time'))`, 'the schedule rows')
  await until(`Boolean(document.querySelector('.schedules-chip'))`, 'the chip')
  await t.both('schedules-thread', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)

  // The popover.
  await run(`document.querySelector('.schedules-chip').click()`)
  await until(`document.querySelectorAll('.schedules-popup .schedules-row').length === 3`, 'the popover')
  await until(`Boolean([...document.querySelectorAll('.schedules-popup .schedules-row')].find((r) => r.textContent.includes("Review Mia's PR"))?.querySelector('[aria-label="Reminds you"]'))`, 'the reminder’s bell')
  await t.hover('.schedules-popup .schedules-row__label', 'Check CI')
  await t.both('schedules-popover')

  // Edit, from the popover: the form, what its time comes to under it.
  await run(`[...document.querySelectorAll('.schedules-popup .schedules-row')].find((r) => r.textContent.includes('Check CI')).querySelector('[aria-label="Edit"]').click()`)
  await until(`document.querySelector('#schedules-when')?.value === 'every 30m' && /^Every 30 min: /.test(document.querySelector('.schedules-form__hint')?.textContent ?? '')`, 'the Edit form')
  await t.both('schedules-edit')
  await t.click('.schedules-form-dialog .superego-button', 'Cancel')
  await until(`!document.querySelector('.schedules-form')`, 'the form closed')

  // New schedule…, on the calendar.
  await run(`document.querySelector('.schedules-chip').click()`)
  await until(`Boolean(document.querySelector('.schedules-popup__item'))`, 'the popover again')
  await t.click('.schedules-popup__item', 'New schedule…')
  await until(`Boolean(document.querySelector('#schedules-when'))`, 'the New form')
  await t.type('#schedules-message', 'Look at the overnight import errors and say if any need me.')
  await t.type('#schedules-when', 'every weekday at 8:30')
  await until(`/^Every weekday at 08:30: /.test(document.querySelector('.schedules-form__hint')?.textContent ?? '')`, 'what the time comes to')
  await t.type('#schedules-until', 'the importer is fixed')
  await t.both('schedules-new')
  await t.click('.schedules-form-dialog .superego-button', 'Cancel')
  await until(`!document.querySelector('.schedules-form')`, 'the form closed again')

  // `/schedule` in the composer: offered as it's typed, then a reminder made from the words.
  const typeComposer = (text, enter = false) => run(`(() => {
    const ta = document.querySelector('.composer textarea')
    ta.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    if (${enter}) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await typeComposer('/sch')
  await until(`[...document.querySelectorAll('.completions__item')].some((i) => i.textContent.includes('/schedule'))`, '/schedule offered')
  await t.both('schedules-command')
  await typeComposer('/schedule remind me in 2h to stretch my legs', true)
  await until(`window.superego.call('local', 'schedules.list', { thread: '${id}' }).then((list) => list.some((s) => s.label === 'Stretch my legs' && s.action === 'notify'))`, 'the reminder /schedule made')

  // The sidebar's clocks, the row's tooltip.
  await until(`!document.querySelector('.schedules-popup')`, 'the popover closed')
  await bothOf('schedules-sidebar', `({ getBoundingClientRect: () => { const r = document.querySelector('.app__sidebar').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: 220 } } })`)

  // Run now, from the popover: the firing.
  await run(`document.querySelector('.schedules-chip').click()`)
  await until(`Boolean(document.querySelector('.schedules-popup'))`, 'the popover again')
  await run(`[...document.querySelectorAll('.schedules-popup .schedules-row')].find((r) => r.textContent.includes('Check CI')).querySelector('[aria-label="Run now"]').click()`)
  await until(`[...document.querySelectorAll('.transcript .msg--user')].some((m) => m.textContent.includes('Check CI on #212') && m.textContent.includes('run 1 of 48'))`, 'the firing')
  await run(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await settle(id)
  await until(`document.querySelector('.transcript')?.textContent.includes('3 of 5 checks pass')`, 'its answer')
  await t.both('schedules-firing', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)

  // Missed while Superego wasn't running: its next run set two hours back, and the daemon restarted.
  const file = join(process.env.SUPEREGO_HOME, 'extensions', 'schedules', 'schedules.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  const check = stored.schedules.find((s) => s.label === 'Check CI')
  check.next = Date.now() - 2 * 60 * 60_000 - 3 * 60_000
  writeFileSync(file, JSON.stringify(stored, null, 2))
  // The replay starts over with the daemon: from here on, only the late run's answer.
  const turns = readFileSync(join(process.env.SUPEREGO_HOME, 'schedules-turns.jsonl'), 'utf8').trim().split('\n')
  writeFileSync(join(process.env.SUPEREGO_HOME, 'schedules-turns.jsonl'), `${turns.at(-1)}\n`)
  const hello = await call('hello', { client: 'look', version: 2 })
  const restarted = await call('daemon.restart', { build: hello.machine.build, interrupt: true })
  if (!restarted.restarted) t.fail('the daemon didn’t restart')
  await until(`document.querySelector('.transcript')?.textContent.includes('4 of 5 checks pass')`, 'the late run, and its answer', 90_000)
  await call('thread.seen', { thread: id })
  await until(`Boolean([...document.querySelectorAll('.transcript .notice')].find((n) => n.textContent.includes('late')))`, 'the late notice')
  await t.both('schedules-late', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)

  // The morning's reminder, run now: a notice, no run.
  const mia = (await call('schedules.list', { thread: id })).find((s) => s.label === "Review Mia's PR")
  await call('schedules.run', { id: mia.id })
  await until(`Boolean(document.querySelector('.transcript .schedules-reminder'))`, 'the reminder')
  await call('thread.seen', { thread: id })
  await t.both('schedules-reminder', `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)

  // Every schedule on the machine, by thread.
  await run(`document.querySelector('.schedules-chip').click()`)
  await until(`Boolean(document.querySelector('.schedules-popup__item--quiet'))`, 'the popover once more')
  await t.click('.schedules-popup__item--quiet', 'All schedules')
  await until(`document.querySelectorAll('.schedules-all .schedules-thread').length === 2`, 'every schedule')
  await t.both('schedules-all')
  await run(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await until(`!document.querySelector('.schedules-all')`, 'every schedule closed')

  // A phone: the thread's menu, then the schedules' sheet.
  await t.resize(600, 1000)
  await t.zoom(1.5)
  await until(`Boolean(document.querySelector('button.app__mobiletitle'))`, 'the phone’s bar')
  await run(`document.querySelector('button.app__mobiletitle').click()`)
  await until(`Boolean(document.querySelector('.thread-sheet'))`, 'the thread’s menu')
  await t.both('schedules-phone-menu')
  await run(`[...document.querySelectorAll('.thread-sheet .thread-sheet__item')].find((i) => i.textContent.includes('Schedules'))?.click()`)
  await until(`document.querySelectorAll('.schedules-sheet .schedules-row').length === 3`, 'the schedules’ sheet')
  await t.both('schedules-phone-sheet')
})

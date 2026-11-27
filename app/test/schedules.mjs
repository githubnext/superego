// Screenshots of schedules (run by `test/look.sh <dir> schedules`): a thread that opened a PR and scheduled a check of
// its CI every 30 minutes until green, and a reminder for the morning; the agent's `schedule` rows with their next
// times; the clock chip in its header and its popover, a paused schedule among them; the clock on its row and another
// thread's in the sidebar; a firing (Run now from the popover); a run missed while Superego wasn't running, fired once
// it's back, late; and the phone's sheet. Light and dark, into $SUPEREGO_SHOWCASE_OUT.
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
  await t.hover('.schedules-popup .schedules-row__label', 'Check CI')
  await t.both('schedules-popover')

  // The sidebar's clocks, the row's tooltip.
  await run(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
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

// The chief of staff at work, for the public site's hero (run by `test/look.sh <dir> staff`): a lead on the
// chief-of-staff profile (test/showcase/profiles, copied into the home by look.sh) with three children under it in the
// sidebar (one working, one done, one waiting on you), its transcript (the request, the children started, their reports
// relayed), the Board beside it with the plan and a decision, and its own question over the composer. Then the board
// alone, and the window at 1440×900. Light and dark, into $SUPEREGO_SHOWCASE_OUT. Nothing is dressed up: the
// turns are scripted (test/showcase/staff.mjs), and everything else is the daemon's and the profile's own.
import { openApp } from './harness.mjs'
import { CHILDREN, EARLIER, LEAD, REQUEST } from './showcase/staff.mjs'

await openApp({ name: 'staff', timeout: 240_000 }, async (t) => {
  const { run, until } = t
  const [width, height] = (process.env.LOOK_SIZE ?? '1100x760').split('x').map(Number)
  await t.resize(width, height)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const list = () => t.call('thread.list', {})
  const byTitle = (title) => `window.superego.call('local', 'thread.list', {}).then((l) => l.find((t) => t.title === ${JSON.stringify(title)}))`

  // The project's history: threads from before, done with.
  for (const title of EARLIER) {
    const { id } = await t.call('thread.start', { cwd: project, title })
    await t.call('thread.seen', { thread: id })
  }
  const lead = await t.call('thread.start', { cwd: project, title: LEAD, profile: 'chief-of-staff' })
  if (lead.profile?.name !== 'chief-of-staff') t.fail(`the lead runs ${JSON.stringify(lead.profile)}, not chief-of-staff: is it in $SUPEREGO_HOME/profiles?`)
  await t.call('thread.send', { thread: lead.id, text: REQUEST })

  // The children as the lead starts them, under it.
  for (const { title } of Object.values(CHILDREN)) {
    const child = await until(byTitle(title), `${title} started`, 60_000)
    if (child.parent !== lead.id) t.fail(`${title} is under ${child.parent}, not the lead (${lead.id})`)
  }
  // Each where the scene wants it: home working, docs done, deploy and the lead each waiting on a question.
  const state = (title) => `${byTitle(title)}.then((t) => t?.status.state)`
  await until(`${state(CHILDREN.docs.title)}.then((s) => s === 'done')`, 'the docs done', 60_000)
  await until(`${state(CHILDREN.deploy.title)}.then((s) => s === 'blocked')`, 'deploy asking', 60_000)
  await until(`${state(LEAD)}.then((s) => s === 'blocked')`, 'the lead asking', 60_000)
  await t.check(`${state(CHILDREN.home.title)}.then((s) => s === 'working')`, 'the home page still working')
  for (const thread of await list()) if (thread.status.state === 'error') t.fail(`${thread.title} failed: ${thread.status.msg}`)

  // The lead shown, its board beside it with the plan, the decision and deploy's question.
  const row = (title) => `[...document.querySelectorAll('.threads-project .superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row(CHILDREN.deploy.title)})`, 'the children listed')
  await run(`${row(LEAD)}.click()`)
  await until(`document.querySelector('.thread__title')?.textContent === ${JSON.stringify(LEAD)}`, 'the lead shown')
  await until(`Boolean(document.querySelector('.staff-board'))`, 'the board open')
  await until(`(() => { const b = document.querySelector('.staff-board')?.textContent ?? ''; return b.includes('Where should the site live?') && b.includes('Public site') && b.includes('Publish with') })()`, 'the board filled in')
  await until(`Boolean(document.querySelector('.composer')?.closest('.thread')?.textContent.includes('Fix the README as well'))`, 'the question over the composer')
  await until(`document.querySelectorAll('.transcript .msg').length >= 3`, 'the transcript in')
  // What the children's branches changed: the board's tick works it out every 30s.
  await until(`document.querySelectorAll('.staff-board .staff-board__stat').length >= 2`, 'the branches\' changes on the board', 60_000)
  await run(`document.activeElement?.blur()`)
  const end = `document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`
  await t.both('staff', end)
  // The board alone, then the window roomier.
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.shot(`staff-board-${theme}`, `document.querySelector('.staff-board').closest('[data-column]')`)
  }
  await t.resize(1440, 900)
  await t.both('staff-wide', end)
})

// Screenshots of the composer and what's around it (run by `test/look.sh <dir> composer`): idle with suggestions, a
// file waiting, the agent working with messages queued and one typed to steer, questions waiting (two options and five), archived, @ mentions
// offered and sent, and the narrow layout; light and dark. Into $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'
import { writeFileSync } from 'node:fs'

// Its own recorded agent, in place of the showcase's, written before the daemon starts and reads it.
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const turn = (content) => ({ content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' })
const turns = [
  // Working: a few steps, then one that runs long.
  turn([{ type: 'text', text: 'Searching for where the focus is set.' }, call('w1', 'bash', { command: 'grep -rn Date src | head -5' }), call('w2', 'read', { path: 'package.json' })]),
  turn([{ type: 'text', text: 'Running the whole suite now.' }, call('w3', 'bash', { command: 'sleep 600' })]),
  // A question with two options, then one with five, their descriptions long enough to wrap.
  turn([call('q1', 'ask_user', { question: 'Which export should the importer read first?', options: ['Danske', 'Nordea'] })]),
  turn([call('q2', 'ask_user', { question: 'Local `main` is 29 commits ahead of `origin/main`, and only 7 are mine. What should I push?', options: [
    { label: 'All of local main', description: 'Merge the last tweak, run the full test suite (and smoke) on main, then push main to origin' },
    { label: 'Only mine', description: 'Put my commits onto origin/main in a branch of their own, test, and push just those, leaving the other threads\' merges for their batch' },
    { label: "Don't push yet", description: 'Merge to local main only' },
    { label: 'Ask the chief of staff' },
    { label: 'Something else', description: 'Say what in your own words' },
  ] })]),
]
// The echo model by default (suggestions come from it: it echoes them back), the recording offered beside it.
process.env.SUPEREGO_REPLAY = process.env.SUPEREGO_MODEL.slice('replay:'.length)
process.env.SUPEREGO_MODEL = 'faux'
writeFileSync(process.env.SUPEREGO_REPLAY, turns.map((message) => JSON.stringify({ at: 0, provider: 'x', model: 'x', message: { role: 'assistant', ...message } })).join('\n') + '\n')

await openApp({ name: 'composer', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  const [width, height] = (process.env.LOOK_SIZE ?? '1100x760').split('x').map(Number)
  await t.resize(width, height)
  const project = process.env.SUPEREGO_SHOWCASE_PROJECT
  const both = async (name) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
      await t.shot(`${name}-${theme}`)
    }
  }
  // The phone layout: the page laid out at a phone's width, as a browser on one would (the window can't get that narrow).
  const emulation = t.contents().debugger
  if (!emulation.isAttached()) emulation.attach()
  const phone = async (name) => {
    for (const theme of ['light', 'dark']) {
      await t.theme(theme)
      await emulation.sendCommand('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 2, mobile: true })
      await until(`innerWidth === 390`, 'a phone’s width')
      await run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight })`)
      await t.shot(`${name}-${theme}`)
      await emulation.sendCommand('Emulation.clearDeviceMetricsOverride')
      await until(`innerWidth === ${width}`, 'the window’s width again')
    }
  }
  const state = (id) => `window.superego.call('local', 'thread.list', {}).then((list) => list.find((s) => s.id === '${id}')?.status.state)`
  const create = (title) => run(`window.superego.call('local', 'thread.start', { cwd: ${JSON.stringify(project)}, title: ${JSON.stringify(title)} }).then((t) => t.id)`)
  const submit = (id, text, whenBusy) => run(`window.superego.call('local', 'thread.send', { thread: '${id}', text: ${JSON.stringify(text)}${whenBusy ? `, whenBusy: '${whenBusy}'` : ''} })`)
  const open = (title) => until(`(() => { const li = [...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes(${JSON.stringify(title)})); li?.click(); return Boolean(li) && document.querySelector('.thread__title')?.textContent === ${JSON.stringify(title)} })()`, `${title} shown`)
  const type = (text) => run(`(() => {
    const ta = document.querySelector('.composer textarea')
    ta.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  // Idle, with what to send next offered.
  const idle = await create('Dates land a day early')
  // A busy transcript first, to run behind the suggestions when scrolled.
  await submit(idle, Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: the importer reads each row's date as UTC midnight, then formats it in local time, so every date lands a day early.`).join('\n\n'))
  await until(`${state(idle)}.then((s) => s === 'done')`, 'busy transcript answered')
  // One runs a skill (look.sh's `commit`), written as a model may: it's offered as `$commit`.
  await submit(idle, 'What next? ["Run the tests", "/commit the date fix", "Write a test for a row dated on the first of a month in summer time, and check the Nordea export too"]')
  await until(`${state(idle)}.then((s) => s === 'done')`, 'idle thread answered')
  await open('Dates land a day early')
  await until(`document.querySelectorAll('.suggestions__item').length === 3 && Boolean(document.querySelector('.suggestions__item:nth-child(2) .suggestions__skill'))`, 'suggestions, one a skill')
  await both('idle-suggestions')
  // One hovered, the transcript scrolled to run behind them: the pill stays solid over it.
  for (const theme of ['light', 'dark']) {
    await t.theme(theme)
    await t.hover('.suggestions__item:nth-child(2)')
    await run(`document.querySelectorAll('.thread__scroll').forEach((el) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true })))`)
    await run(`document.querySelectorAll('.thread__scroll').forEach((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 150 })`)
    await until(`Boolean(document.querySelector('.suggestions__item:hover'))`, 'a suggestion hovered')
    await t.shot(`idle-suggestion-hover-${theme}`)
  }
  await t.hover('.composer textarea')
  // A file waiting to go, with words typed.
  await run(`(() => {
    const input = document.querySelector('.dock input[type=file]')
    const files = new DataTransfer()
    files.items.add(new File(['# plan\\n'], 'plan.md', { type: 'text/markdown' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(`Boolean(document.querySelector('.composer__files .attachment'))`, 'file waiting')
  await type('Also read this plan')
  await both('idle-file')
  await type('')
  await run(`document.querySelector('.attachment__remove')?.click()`)

  // The echo model, to go back to for the mentions below once the recording is used up.
  const echo = await run(`window.superego.call('local', 'settings.watch', {}).then((s) => s.value.values['agent.model'] ?? null)`)
  await run(`window.superego.call('local', 'settings.set', { key: 'agent.model', value: 'replay/replay' })`)
  // Working, a follow-up queued (to send now), a steer waiting for the step, and words typed to steer with.
  const working = await create('Focus ring disappears')
  await submit(working, 'The focus ring disappears when a pane opens beside. Find out why and fix it')
  await until(`window.superego.call('local', 'thread.list', {}).then(async (list) => list.find((s) => s.id === '${working}')?.status.state === 'working')`, 'working')
  await open('Focus ring disappears')
  // Its steps folded into one line, the long one among them: what it said along the way is under the fold, not drawn.
  await until(`document.querySelector('.transcript .steps--run .row__summary')?.textContent === 'Ran 2 commands and read a file'`, 'long step running')
  await submit(working, 'Then run the smoke test on main', 'followUp')
  await submit(working, 'Leave the e2e suite out of it', 'steer')
  await until(`document.querySelectorAll('.queued-row').length === 2`, 'a follow-up and a steer waiting')
  await type('also check split panes, not just beside')
  await both('working-queued')
  await phone('working-queued-narrow')
  await type('')
  await both('working')

  // A question waiting for an answer.
  const asking = await create('Pick an export')
  await submit(asking, 'Which export first?')
  await open('Pick an export')
  await until(`Boolean(document.querySelector('.agent-ui-waiting'))`, 'question')
  await both('question')
  await phone('question-narrow')
  const asking5 = await create('Push what')
  await submit(asking5, 'Push it')
  await open('Push what')
  await until(`document.querySelectorAll('.agent-ui-question__option').length === 5`, 'five options')
  await both('question-five')
  await phone('question-five-narrow')

  // Archived: read only, with the way back.
  await run(`window.superego.call('local', 'thread.archive', { thread: '${idle}' })`)
  await run(`window.superego.call('local', 'thread.stop', { thread: '${working}' })`)
  await run(`window.superego.call('local', 'thread.stop', { thread: '${asking}' })`)
  await run(`window.superego.call('local', 'thread.stop', { thread: '${asking5}' })`)
  await run(`document.querySelector('.threads-archived button, .threads-archived summary')?.click()`)
  await until(`(() => { const li = [...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Dates land a day early')); li?.click(); return Boolean(li) && Boolean(document.querySelector('.titlebar__archived')) })()`, 'archived thread shown')
  await both('archived')
  await phone('archived-narrow')

  // Mentions: @ offers other threads, then the thread's files; sent, they show as links and the agent is told of them.
  await run(`window.superego.call('local', 'settings.set', { key: 'agent.model', value: ${JSON.stringify(echo)} })`)
  await create('Mention a thread')
  await open('Mention a thread')
  await type('Compare with @')
  await until(`document.querySelectorAll('.completions__item').length > 3`, 'threads and files offered')
  await both('mention-menu')
  await type('Compare with @dat')
  await until(`document.querySelector('.completions__item.is-active')?.textContent.startsWith('dates.mjs')`, 'the file offered')
  await both('mention-file')
  await type(`Why does @thread:${working} keep failing in @src/dates.mjs?`)
  await run(`document.querySelector('.composer__send').click()`)
  await until(`Boolean(document.querySelector('.transcript .thread-ref')) && Boolean(document.querySelector('.transcript .md__file'))`, 'the mentions drawn as links')
  await both('mention-sent')
})

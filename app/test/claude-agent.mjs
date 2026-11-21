// Screenshots of Claude Agent (run by `test/look.sh <dir> claude-agent`): a thread waiting on a permission, the user's
// own `claude` (look.sh's wrapper, `SUPEREGO_CLAUDE`) asking to run a command, shown above the composer with Allow, Deny
// and Always; Settings → Claude Agent, saying what Claude Code is on this computer; and ⌘N's model menu with its
// group. Light and dark, into $SUPEREGO_SHOWCASE_OUT. `claude` talks to a stand-in for
// the Messages API here, so nothing needs an account or costs anything.
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { openApp } from './harness.mjs'

const home = process.env.SUPEREGO_HOME

// The stand-in: to "Run the tests", a line and a Bash call of `npm test` (which waits on the user); else a line.
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
let n = 0
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stand-in' } }))
    return
  }
  const request = JSON.parse(body)
  // Asked to run the tests, and not yet answered.
  const asked = request.messages.findLastIndex((m) => m.role === 'user' && JSON.stringify(m.content).includes('Run the tests'))
  const content = asked >= 0 && !request.messages.slice(asked).some((m) => m.role === 'assistant')
    ? [{ type: 'text', text: "I'll run the test suite to see where it stands." }, { type: 'tool_use', id: `toolu_look_${++n}`, name: 'Bash', input: { command: 'npm test -- --reporter=dot', description: 'Run the test suite' } }]
    : [{ type: 'text', text: 'Done.' }]
  const message = { id: `msg_look_${++n}`, type: 'message', role: 'assistant', model: request.model, content, stop_reason: content.at(-1).type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }
  if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message)); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  sse(res, 'message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  content.forEach((block, index) => {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
    sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  })
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
// look.sh's wrapper reads where it is as `claude` starts.
writeFileSync(`${home}/claude-mock-url`, `http://127.0.0.1:${server.address().port}`)

await openApp({ name: 'claude-agent', timeout: 180_000, size: [1100, 760] }, async (t) => {
  const { until } = t
  const { id } = await t.call('thread.start', { cwd: process.env.SUPEREGO_SHOWCASE_PROJECT, title: 'Fix the flaky ledger test', profile: 'claude' })
  await t.call('thread.send', { thread: id, text: 'Run the tests and fix whatever fails.' })
  // Asked within a minute, or what the thread did instead is said.
  const status = async () => (await t.call('thread.list', {})).find((thread) => thread.id === id)?.status
  for (let tries = 0; (await status())?.kind !== 'permission'; tries++) {
    if (tries > 120 || (await status())?.state === 'error' || (await status())?.state === 'done') t.fail(`the thread didn't ask: ${JSON.stringify(await status())}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  const row = `[...document.querySelectorAll('.superego-list-item')].find((li) => li.querySelector('.threads__title')?.textContent === 'Fix the flaky ledger test')`
  await until(`Boolean(${row})`, 'the thread listed')
  await t.run(`${row}.click()`)
  await until(`Boolean(document.querySelector('.claude-agent-approval'))`, 'the approval card')
  await t.both('claude-agent-permission')
  // Answered (denied: the command isn't run), it goes on.
  await t.click('.claude-agent-approval__label', 'Deny')
  await until(`window.superego.call('local', 'thread.list', {}).then((list) => list.find((t) => t.id === '${id}')?.status.state === 'done')`, 'the turn done', 60_000)

  // Settings → Claude Agent: Claude Code on this computer, signed in.
  await t.click('.app__settings')
  await until(`[...document.querySelectorAll('.settings__nav button')].some((b) => b.textContent.trim() === 'This computer')`, 'Settings')
  await t.run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.trim() === 'This computer').click()`)
  await until(`document.querySelector('.claude-agent-settings')?.textContent.includes('Signed in with your Claude Max plan')`, 'Settings → Claude Agent')
  await t.both('claude-agent-settings', `document.querySelector('.claude-agent-settings').closest('.settings-section').scrollIntoView({ block: 'center' })`)
  t.key('Escape', [])

  // ⌘N's model menu: Claude Agent's models in a group of their own.
  await t.click('.app__rail [aria-label="Threads"]')
  t.key('n')
  await until(`!!document.querySelector('.new-thread .model-picker__button:not(:disabled)')`, 'the new thread dialog')
  // With no profile picked, so the providers' models are there too.
  await t.run(`(() => { const select = document.querySelector('.new-thread select[aria-label="Profile"]'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await until(`document.querySelector('.new-thread select[aria-label="Profile"]').value === ''`, 'no profile')
  await t.click('.new-thread .model-picker__button')
  const group = `[...document.querySelectorAll('.model-picker__heading')].find((h) => h.textContent.startsWith('Claude Agent'))`
  await until(`!!${group}`, 'the Claude Agent group')
  await t.both('claude-agent-model-menu', `${group}.scrollIntoView({ block: 'start' })`)
  server.close()
})

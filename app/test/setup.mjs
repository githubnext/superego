// Screenshots of first-run setup (run by test/look.sh <dir> setup), on a fresh home with no model: the page as it
// opens, with Claude Code (a stand-in `claude`, signed in) and Ollama (a stand-in server) found; a key's field open; a
// composer that couldn't send, and its card; Ollama used, saying hi; Claude Code used. Light and dark, into
// $SUPEREGO_SHOWCASE_OUT.
import { chmodSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { openApp } from './harness.mjs'

// Ollama, as setup finds it: models to list, and a line for every chat.
const ollama = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    return response.end(JSON.stringify({ object: 'list', data: ['qwen3:32b', 'llama3.1:8b', 'gpt-oss:20b', 'gemma3:12b', 'mistral-small:24b', 'phi4:14b'].map((id) => ({ id })) }))
  }
  request.resume()
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'qwen3:32b', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.write(chunk({ role: 'assistant', content: 'Hi! Ready when you are.' }, null))
    response.write(chunk({}, 'stop'))
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve))
process.env.SUPEREGO_OLLAMA = `http://127.0.0.1:${ollama.address().port}/v1`
process.env.SUPEREGO_LMSTUDIO = 'http://127.0.0.1:9/v1'
// Claude Code, installed and signed in: what `claude auth status` says, and nothing else.
const claude = join(process.env.SUPEREGO_HOME, 'claude')
writeFileSync(claude, `#!/bin/sh\n[ "$1 $2" = "auth status" ] && echo '{"loggedIn":true,"authMethod":"claude.ai"}'\n`)
chmodSync(claude, 0o755)
process.env.SUPEREGO_CLAUDE = claude
// No model: none scripted, and no key from this machine's environment.
delete process.env.SUPEREGO_MODEL
for (const name of Object.keys(process.env)) if (/_(API_KEY|TOKEN|ACCESS_KEY_ID|PROFILE)$/.test(name)) delete process.env[name]

await openApp({ name: 'setup', timeout: 180_000 }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 760)
  const row = (title) => `[...document.querySelectorAll('.setup__row')].find((r) => r.querySelector('.setup__what')?.firstElementChild?.textContent === ${JSON.stringify(title)})`
  await until(`Boolean(${row('Ollama')}) && Boolean(${row('Claude Code')})`, 'setup, with Ollama and Claude Code found', 30_000)
  await t.both('setup')
  await run(`${row('Paste an API key')}.querySelector('button').click()`)
  await until(`Boolean(document.querySelector('.setup__key'))`, 'the key field')
  await t.both('setup-key')

  // Skipped: a thread that can't send says so where it was sent, with a way to set one up.
  await t.click('.setup__foot button', 'Skip for now')
  await until(`!document.querySelector('.setup')`, 'setup skipped')
  await t.call('thread.start', { cwd: process.env.SUPEREGO_SHOWCASE_PROJECT, title: 'Tidy the categories' })
  await until(`Boolean([...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Tidy the categories')))`, 'the thread listed')
  await run(`[...document.querySelectorAll('.superego-list-item')].find((li) => li.textContent.includes('Tidy the categories')).click()`)
  await until(`Boolean(document.querySelector('.composer textarea'))`, 'the thread shown')
  await t.type('.composer textarea', 'Say hi')
  await run(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await until(`Boolean(document.querySelector('.setup-card'))`, "the composer's card")
  await t.both('setup-card')

  await t.click('.setup-card button', 'Set up models…')
  await until(`Boolean(${row('Ollama')})`, 'setup, for the thread')
  await run(`${row('Ollama')}.querySelector('button').click()`)
  await until(`document.querySelector('.setup h1')?.textContent === 'It talks.' && Boolean(document.querySelector('.setup__bubble'))`, 'Ollama saying hi')
  await t.both('setup-ready')

  await t.click('.setup__another', 'Add another way')
  await until(`Boolean(${row('Claude Code')}?.querySelector('button:not(:disabled)'))`, 'Claude Code to use')
  await run(`${row('Claude Code')}.querySelector('button').click()`)
  await until(`document.querySelector('.setup h1')?.textContent === 'Ready.' && document.querySelector('.setup')?.textContent.includes('claude profile')`, 'Claude Code used')
  await t.both('setup-claude')
  await t.click('.setup__foot button', 'Back to the thread')
  await until(`!document.querySelector('.setup') && document.querySelector('.thread__title')?.textContent === 'Tidy the categories'`, 'back at the thread')
  ollama.close()
  console.log(`setup: done in ${process.env.SUPEREGO_SHOWCASE_OUT}`)
})

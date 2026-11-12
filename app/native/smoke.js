// Executed as an async function by the hidden WKWebView, not loaded by the renderer.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, message) {
  for (let i = 0; i < 15; i++) {
    const value = check()
    if (value) return value
    await sleep(100)
  }
  throw Error(`${message}: ${document.body.innerText.slice(-1000)}`)
}

const bridge = await waitFor(() => window.superego, 'Bridge missing')
const threads = await bridge.call('local', 'thread.list', {})
if (!threads.length) throw Error('No seeded threads')
const row = await waitFor(() => [...document.querySelectorAll('[role="option"]')]
  .find(element => element.textContent.includes('Native socket smoke')), 'Seeded thread missing from sidebar')
row.click()
const input = await waitFor(() => document.querySelector('.composer textarea'), 'Composer missing')
let events = 0
const unsubscribe = bridge.onEvent(event => { if (event.method === 'watch.ops') events++ })
try {
  // Use the native setter so React sees a user edit rather than a value it already tracks.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Native WebKit message')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(100)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  await waitFor(() => events && document.body.innerText.includes('echo: Native WebKit message'), 'Missing streamed echo')
  return JSON.stringify({ events, text: document.body.innerText.slice(-1500) })
} finally {
  unsubscribe()
}

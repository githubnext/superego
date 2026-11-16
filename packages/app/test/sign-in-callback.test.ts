// Another computer's sign-in, caught here: the app listens at the flow's loopback callback while it's open, and answers
// its "paste the URL" prompt with the URL the browser came back to.
import { createServer } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { createSignInCatcher } from '../src/main/sign-in-callback.ts'

const freePort = () => new Promise<number>((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number }
    server.close(() => resolve(port))
  })
})
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 10)) }
  throw new Error('timed out')
}
const closers: (() => void)[] = []
afterEach(() => { for (const close of closers.splice(0)) close() })

function catcher() {
  const answers: { machine: string; flow: string; prompt: string; value: string }[] = []
  const catching = createSignInCatcher(async (machine, params) => { answers.push({ machine, ...params }) })
  closers.push(() => catching.close())
  return { catching, answers }
}
/** Whether something listens on `port` here now. */
const listening = (port: number) => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)

it("answers the flow's manual_code prompt with the URL the browser came back to, then stops listening", async () => {
  const { catching, answers } = catcher()
  const port = await freePort()
  const callback = `http://127.0.0.1:${port}/mcp/callback`
  catching.heard('box', 'f1', { type: 'auth_url', url: 'https://auth.example/authorize', callback })
  await until(() => listening(port))
  // The prompt comes after the page: the URL waits for it.
  const page = await fetch(`${callback}?code=abc&state=xyz`)
  expect(page.status).toBe(200)
  expect(await page.text()).toMatch(/close this tab/)
  expect(answers).toEqual([])
  catching.heard('box', 'f1', { type: 'prompt', id: 'p1', prompt: { type: 'manual_code', message: 'Paste the URL' } })
  expect(answers).toEqual([{ machine: 'box', flow: 'f1', prompt: 'p1', value: `${callback}?code=abc&state=xyz` }])
  expect(await listening(port)).toBe(false)
})

it('answers a prompt already waiting, ignores other paths and other flows, and stops when the flow ends', async () => {
  const { catching, answers } = catcher()
  const port = await freePort()
  const callback = `http://127.0.0.1:${port}/cb`
  catching.heard('box', 'f1', { type: 'auth_url', url: 'https://auth.example/a', callback })
  catching.heard('box', 'f1', { type: 'prompt', id: 'p1', prompt: { type: 'manual_code', message: 'Paste' } })
  catching.heard('box', 'f2', { type: 'prompt', id: 'p2', prompt: { type: 'manual_code', message: 'Paste' } })
  await until(() => listening(port))
  expect((await fetch(`http://127.0.0.1:${port}/elsewhere?code=1`)).status).toBe(404)
  await fetch(`${callback}?code=1`)
  await until(() => answers.length === 1)
  expect(answers[0]).toMatchObject({ flow: 'f1', prompt: 'p1' })

  // Pasted first (the prompt closed): nothing to answer, and the flow's end stops it.
  const second = await freePort()
  catching.heard('box', 'f3', { type: 'auth_url', url: 'https://auth.example/a', callback: `http://127.0.0.1:${second}/cb` })
  catching.heard('box', 'f3', { type: 'prompt', id: 'p3', prompt: { type: 'manual_code', message: 'Paste' } })
  catching.heard('box', 'f3', { type: 'prompt_closed', id: 'p3' })
  await until(() => listening(second))
  catching.heard('box', 'f3', { type: 'done' })
  await new Promise((r) => setTimeout(r, 50))
  expect(await listening(second)).toBe(false)
  expect(answers).toHaveLength(1)
})

it("leaves alone what isn't a loopback http address, and a port that's taken", async () => {
  const { catching, answers } = catcher()
  for (const callback of ['https://127.0.0.1:4567/cb', 'http://example.com:4567/cb', 'http://127.0.0.1:80/cb', 'not a url']) {
    catching.heard('box', 'f', { type: 'auth_url', url: 'https://a', callback })
  }
  const taken = createServer().listen(0, '127.0.0.1')
  await new Promise((r) => taken.once('listening', r))
  closers.push(() => taken.close())
  const port = (taken.address() as { port: number }).port
  catching.heard('box', 'g', { type: 'auth_url', url: 'https://a', callback: `http://127.0.0.1:${port}/cb` })
  catching.heard('box', 'g', { type: 'prompt', id: 'p', prompt: { type: 'manual_code', message: 'Paste' } })
  await new Promise((r) => setTimeout(r, 50))
  expect(answers).toEqual([])
})

it("turns away a request without the page's state, and goes on listening for the real one", async () => {
  const { catching, answers } = catcher()
  const port = await freePort()
  const callback = `http://127.0.0.1:${port}/mcp/callback`
  catching.heard('box', 'f1', { type: 'auth_url', url: 'https://auth.example/authorize?client_id=c&state=the-state', callback })
  catching.heard('box', 'f1', { type: 'prompt', id: 'p1', prompt: { type: 'manual_code', message: 'Paste' } })
  await until(() => listening(port))
  for (const query of ['?code=evil&state=other', '?code=evil']) {
    const wrong = await fetch(`${callback}${query}`)
    expect(wrong.status).toBe(400)
    expect(await wrong.text()).toMatch(/isn't the sign-in/)
  }
  expect(answers).toEqual([])
  expect(await listening(port)).toBe(true)
  await fetch(`${callback}?code=abc&state=the-state`)
  await until(() => answers.length === 1)
  expect(answers[0]).toMatchObject({ prompt: 'p1', value: `${callback}?code=abc&state=the-state` })
})

// @vitest-environment happy-dom
// Stopping a thread from the window over a real daemon: the messages you'd queued come back into its composer, after
// what's typed, in order, their files with them; another thread's are withdrawn, as the transcript says; with nothing
// queued, the composer is left as it was.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { defineDaemonExtension, type DaemonApi } from '@superego/daemon'
import { obj } from '@superego/protocol'
import { callTool, mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const typed = () => ($('.composer textarea') as HTMLTextAreaElement | null)?.value
const transcript = () => $('.transcript')?.textContent ?? ''

let daemon: TestDaemon
let ui: TestWindow
let api: DaemonApi
// Its agent's `wait` runs until the thread is stopped.
const waiter = defineDaemonExtension({
  name: 'waiter',
  setup(superego) {
    api = superego
    superego.agent(defineExtension({
      name: 'waiter',
      tools: [defineTool({
        name: 'wait', description: 'Waits until stopped.', parameters: obj({}), replay: 'safe',
        async execute(_args, _api, context) {
          while (!context.abortSignal?.aborted) await new Promise((r) => setTimeout(r, 20))
          throw new Error('stopped')
        },
      })],
    }))
  },
})
beforeEach(async () => { daemon = await testDaemon({ extensions: [waiter], model: [callTool('wait'), callTool('wait')] }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

/** A thread at work, shown, with `draft` typed in its composer. */
async function working(draft: string) {
  const thread = await daemon.thread(undefined, { title: 'busy' })
  ui = await mountUi({ window: true, machines: [daemon], select: { thread: thread.id } })
  await daemon.call('thread.send', { thread: thread.id, text: 'go' })
  await ui.until(() => Boolean($('.composer__stop')), 'the agent at work')
  await ui.type('.composer textarea', draft)
  return thread
}

it("gives the messages you'd queued back to the composer, after what's typed, in order, their files too; another thread's withdrawn", async () => {
  const lead = await daemon.thread(undefined, { title: 'Lead' })
  const thread = await working('half a thought')
  const plan = { name: 'plan.md', mimeType: 'text/markdown', data: btoa('# plan\n') }
  await daemon.call('thread.send', { thread: thread.id, text: 'first queued', whenBusy: 'followUp', attachments: [plan] })
  await api.threads.send(thread.id, 'from the lead', { from: lead.id })
  await daemon.call('thread.send', { thread: thread.id, text: 'second queued\non two lines', whenBusy: 'followUp' })
  await ui.until(() => $$('.queued-row').length === 3, 'three waiting')

  $('.composer__stop')!.click()
  await ui.until(() => typed() === 'half a thought\n\nfirst queued\n\nsecond queued\non two lines', 'yours back in the composer')
  await ui.until(() => !$('.queued-row') && transcript().includes('Stopped: 1 queued message from Lead withdrawn.'), "the lead's withdrawn, said")
  expect($$('.composer__files .attachment').map((a) => a.textContent)).toEqual([expect.stringContaining('plan.md')])
  expect(transcript()).not.toContain('from the lead')

  // Sent again, as written.
  await ui.key('enter')
  await daemon.until(async () => (await daemon.transcript(thread)).includes('second queued\\non two lines'), 'sent again')
  expect(await daemon.transcript(thread)).toContain('<attachment name=\\"plan.md\\"')
})

it('leaves the composer alone when nothing was queued', async () => {
  const thread = await working('keep me')
  $('.composer__stop')!.click()
  await daemon.until(async () => (await daemon.info(thread)).status.state !== 'working', 'stopped')
  await ui.until(() => !$('.composer__stop'), 'shown stopped')
  expect(typed()).toBe('keep me')
  expect(transcript()).not.toContain('Stopped:')
})


// Watching an agent's tool calls from a profile, as daemon.md's "Watching tool calls" shows: `hook(ToolTask, …)` from
// 'superego', in an agent extension the daemon half gives its agents.
import { afterEach, expect, it } from 'vitest'
import { callTool, say, testDaemon, type TestDaemon } from '../src/testing.ts'

let daemon: TestDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

const PROFILE = {
  'profile.ts': `import { defineProfile } from 'superego'\nexport default defineProfile({ extensions: ['./db.ts'] })\n`,
  'db.ts': `import { defineDaemonExtension, defineExtension, defineTool, hook, obj, str, ToolTask } from 'superego'
export default defineDaemonExtension({
  name: 'db',
  setup(superego) {
    const touched = superego.state<{ why: string }>()
    superego.facts(({ state }) => state)
    superego.agent(defineExtension({
      name: 'db',
      tools: [defineTool({ name: 'run', description: 'Run a command.', parameters: obj({ command: str() }), async execute() { return { output: [{ type: 'text', text: 'ok' }] } } })],
      hooks: [hook(ToolTask, {
        async afterTool(call, result, api) {
          const command = String(call.arguments.command ?? '')
          const thread = superego.threads.of(api.conversationId)
          if (thread && /sqlite3/.test(command)) await touched.set(thread, { why: command })
          return result
        },
      })],
    }))
  },
})
`,
}

it("hears a profile's tool calls through hook(ToolTask, { afterTool })", async () => {
  daemon = await testDaemon({ profile: PROFILE, model: [callTool('run', { command: 'sqlite3 app.db .tables' }), say('Done.')] })
  const thread = await daemon.thread('Look at the database')
  const [info] = (await daemon.call<{ id: string; ext?: Record<string, unknown> }[]>('thread.list', {})).filter((t) => t.id === thread.id)
  expect(info?.ext?.db).toEqual({ why: 'sqlite3 app.db .tables' })
})

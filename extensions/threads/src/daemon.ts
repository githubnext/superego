// threads, daemon half: the agent's thread tools (tools.ts), on `superego.threads`. An extension of its own name,
// `thread-tools`, so a machine can switch them off and a profile go without them while the sidebar stays.
import { defineDaemonExtension } from '@superego/daemon'
import { readsOf } from './reads.ts'
import { toolsAbout } from './shared.ts'
import { threadTools } from './tools.ts'

export default defineDaemonExtension({
  ...toolsAbout,
  setup: (s) => s.agent(threadTools({
    info: (id) => s.threads.get(id).catch(() => undefined),
    list: () => s.threads.list(),
    start: (parent, params) => s.threads.create({ ...params, parent }),
    send: (id, text) => s.threads.submit(id, text),
    answer: (id) => s.threads.lastAnswer(id),
    archive: (id) => s.threads.archive(id),
    archiveWhenDone: async (id) => { await s.threads.archive(id, { whenIdle: true }) },
    read: (reader, thread) => readsOf(s.harness).note(reader, thread),
  })),
})

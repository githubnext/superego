// thread-tools, daemon half: the agent's thread tools (tools.ts), on `superego.threads`. An extension of its own,
// `thread-tools`, so a machine can switch them off and a profile go without them while the sidebar stays.
import { hostname } from 'node:os'
import { defineDaemonExtension } from '@superego/daemon'
import { readsOf } from './reads.ts'
import { about } from './shared.ts'
import { threadTools } from './tools.ts'

export default defineDaemonExtension({
  ...about,
  setup: (s) => s.agent(threadTools({
    info: (id) => s.threads.get(id).catch(() => undefined),
    list: () => s.threads.list(),
    start: (parent, params) => s.threads.start({ ...params, parent }),
    send: (id, text) => s.threads.send(id, text),
    answer: (id) => s.threads.lastAnswer(id),
    archive: (id) => s.threads.archive(id),
    archiveWhenDone: async (id) => { await s.threads.archive(id, { whenIdle: true }) },
    read: (reader, thread) => readsOf(s.dataDir).note(reader, thread),
    hostname: () => hostname(),
    machines: () => s.machines.list(),
    remote: (machine, method, params) => s.machines.call(machine, method, params),
  })),
})

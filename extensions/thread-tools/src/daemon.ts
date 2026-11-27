// thread-tools, daemon half: the agent's thread tools (tools.ts), on `superego.threads`. An extension of its own,
// `thread-tools`, so a machine can switch them off and a profile go without them while the sidebar stays.
import { hostname } from 'node:os'
import { defineDaemonExtension } from '@superego/daemon'
import { about } from './shared.ts'
import { threadTools } from './tools.ts'

export default defineDaemonExtension({
  ...about,
  setup(s) {
    s.agent(threadTools({
      info: (id) => s.threads.get(id).catch(() => undefined),
      list: () => s.threads.list(),
      start: (parent, params) => s.threads.start({ ...params, parent }),
      send: async (id, text, from) => { await s.threads.send(id, text, { from }) },
      answer: (id) => s.threads.lastAnswer(id),
      idle: (id, signal) => s.threads.idle(id, { signal }),
      archive: (id) => s.threads.archive(id),
      archiveWhenDone: async (id) => { await s.threads.archive(id, { whenIdle: true }) },
      read: (reader, read) => s.threads.noteRead(reader, read),
      hostname: () => hostname(),
      machines: () => s.machines.list(),
      remote: (machine, method, params) => s.machines.call(machine, method, params),
    }))
  },
})

// threads, daemon half: the agent's thread tools (tools.ts), on `superego.threads`. An extension of its own name,
// `thread-tools`, so a machine can switch them off and a profile go without them while the sidebar stays.
import { defineDaemonExtension } from '@superego/daemon'
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
    async archive(id) {
      await s.threads.archive(id)
      const { worktree } = await s.threads.get(id)
      return { worktree: worktree ? (worktree.removed ? 'removed' : 'kept') : null }
    },
    archiveWhenDone: (id) => s.threads.archive(id, { whenIdle: true }),
  })),
})

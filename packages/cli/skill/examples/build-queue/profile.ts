// A project's build queue, data-only: the agent queues commands, they run one at a time in the thread's folder, and the
// thread's queue shows beside it, drawn by the window from data. Copy this folder to <project>/.superego/profiles/builds
// (then `superego profile allow builds`), or start from `superego extension new builds`.
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Queues builds',
  prompt: 'Queue builds and checks with enqueue_build rather than running them yourself.',
  extensions: ['./builds/daemon.ts'],
})

// A project's build queue, with a UI half of its own: the agent queues commands, they run one at a time in the thread's
// folder, and the window draws the thread's queue beside it with its own component (⌘⇧B shows or hides it). Copy this
// folder to <project>/.superego/profiles/builds (then `superego profile allow builds`), or start from
// `superego extension new builds --tool --ui`.
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Queues builds',
  prompt: 'Queue builds and checks with enqueue_build rather than running them yourself.',
  extensions: ['./builds/daemon.ts'],
  ui: ['./builds/ui.tsx'],
})

// tasks, UI half: runs of work shown as the tasks the agent reported (see daemon.ts), each with how it went and its
// outcome, its steps folded under it.
import { defineUiExtension } from '@superego/app/ui'
import { divide } from './divide.ts'
import { about } from './shared.ts'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.work(divide)
  },
})

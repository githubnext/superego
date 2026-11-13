// tasks, daemon half: `task_start` and `task_finish`, for the agent to report its work as a few human-sized tasks
// ("Investigating duplicate charges") instead of a stream of reads and commands, and how to use them in its prompt.
// The tools only echo; the UI half reads the task boundaries back out of the transcript.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { obj, oneOf, str } from '@earendil-works/pi-schema'
import { defineDaemonExtension } from '@superego/daemon'
import { about, ENDINGS, FINISH, START } from './shared.ts'

const PROMPT = `Report your work as short, human-scale tasks using ${START} and ${FINISH}.
Before investigating, reading, editing, or testing, call ${START} with a concise action-oriented title such as "Reading up on billing", "Investigating duplicate charges", or "Improving authentication". Wait for its returned task_id before working.
Keep exactly one task open at a time. A task follows an intent, not a tool call, reasoning step, file, or command. Group as much related work as makes sense under that intent. Mention filenames only when they meaningfully describe the task. Do not create tasks for a simple conversational answer that requires no work.
While a task is open, your commentary, reasoning, and tool calls are folded inside it. Do not repeat the title as a separate progress message.
When the task ends, call ${FINISH} with its exact task_id, an honest status (success, failure, or inconclusive), and a short outcome. Use inconclusive when changing plans, abandoning an approach, or not finding enough evidence. A failed command alone does not make the whole task a failure. Never claim success without evidence.
Finish the current task before starting the next. Finish all tasks before ending your turn. If you resume interrupted work, start a new task rather than claiming the earlier one completed.
The task's outcome IS the completion recap. Do not repeat it in your final message, restate the changes, or repeat build/test results. Only write a final message when it adds something new: an answer to a separate question, a decision, a tradeoff, a question for the user, or an important caveat.`

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.agent(defineExtension({
      name: 'tasks',
      tools: [
        defineTool({
          name: START,
          description: `Start a human-scale task before doing work. Returns the task_id to pass to ${FINISH}. One task may contain many tool calls; do not report every file or command as a task.`,
          parameters: obj({ title: str({ minLength: 1, maxLength: 120 }) }),
          replay: 'safe',
          executionMode: 'sequential',
          async execute({ title }, api) {
            return { output: [{ type: 'text', text: JSON.stringify({ task_id: api.callId, title }) }] }
          },
        }),
        defineTool({
          name: FINISH,
          description: 'Finish a task. success: goal achieved; failure: goal failed; inconclusive: changed plans, abandoned, or insufficient evidence. A failed individual tool call does not necessarily mean the task failed.',
          parameters: obj({ task_id: str({ minLength: 1 }), status: oneOf(ENDINGS), outcome: str({ minLength: 1, maxLength: 240 }) }),
          replay: 'safe',
          executionMode: 'sequential',
          async execute(args) {
            return { output: [{ type: 'text', text: JSON.stringify(args) }] }
          },
        }),
      ],
      sections: [section('task_reporting', () => PROMPT)],
    }))
  },
})

// Claude Agent, UI half: above the composer, a folder's Claude Code settings waiting to be allowed
// (project-notice.tsx) and what a thread's Claude Code waits on the user for (approval.tsx); and its own tools' rows in
// the transcript: a subagent's (Agent) with its steps under it, a plan it proposed, a question it asked; on first-run
// setup, Claude Code when it's there (setup.tsx); Settings → Claude Agent, Claude Code on each machine (settings.tsx).
import { defineUiExtension, has, Markdown, Output, ToolSteps, useValue, type ToolRow, type ToolRowCall } from '@superego/app/ui'
import { Waiting } from './approval.tsx'
import { ProjectNotice } from './project-notice.tsx'
import { ClaudeSection } from './settings.tsx'
import { ClaudeFound } from './setup.tsx'
import { about, AGENT_TOOL, KEPT, SECTION, type Kept, type SubagentSteps } from './shared.ts'
import './styles.css'

/** A subagent's work, as the thread keeps it, by its Agent call. */
function useWork({ machine, thread, call }: ToolRowCall): SubagentSteps | undefined {
  const kept = useValue<Kept>(machine, KEPT, { scope: thread.id })
  return has(machine, `ext:${about.name}`) ? kept?.subagents?.[call.id] : undefined
}

const VERBS: Record<SubagentSteps['status'], string> = { running: 'Running a subagent', completed: 'Ran a subagent', failed: 'Subagent failed', stopped: 'Subagent stopped' }

/** How a subagent stands: running on after its call returned, if it does (Claude Code runs them in the background). */
function SubagentVerb({ call }: { call: ToolRowCall }) {
  const work = useWork(call)
  if (work) return <>{VERBS[work.status]}</>
  return <>{call.state === 'error' ? VERBS.failed : call.state === 'done' ? VERBS.completed : 'Starting a subagent'}</>
}

/** What a subagent did, under its call: its steps, then what it found. */
function SubagentBody({ call }: { call: ToolRowCall }) {
  const work = useWork(call)
  const said = work?.summary ?? call.result?.text
  return (
    <div className="claude-agent-subagent">
      {work && work.steps.length > 0 && <ToolSteps machine={call.machine} thread={call.thread} steps={work.steps} results={work.results} />}
      {said && <Output text={said} />}
    </div>
  )
}

const agentRow: ToolRow = {
  verbs: [VERBS.completed, 'Starting a subagent', VERBS.failed],
  verb: (call) => <SubagentVerb call={call} />,
  subject: (call) => typeof call.call.arguments.description === 'string' ? call.call.arguments.description : null,
  body: (call) => <SubagentBody call={call} />,
  phrase: (count) => count === 1 ? 'ran a subagent' : `ran ${count} subagents`,
}

const planRow: ToolRow = {
  verbs: ['Proposed a plan', 'Proposing a plan', 'Plan not approved'],
  subject: () => null,
  body: (call) => typeof call.call.arguments.plan === 'string' ? <div className="claude-agent-plan"><Markdown text={call.call.arguments.plan} /></div> : undefined,
  phrase: () => 'proposed a plan',
}

const questionRow: ToolRow = {
  verbs: ['Asked', 'Asking', 'Not answered'],
  subject: (call) => {
    const [first] = Array.isArray(call.call.arguments.questions) ? call.call.arguments.questions as { question?: unknown }[] : []
    return typeof first?.question === 'string' ? first.question : null
  },
  phrase: (count) => count === 1 ? 'asked a question' : `asked ${count} questions`,
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.slot('composer.above', ProjectNotice, { order: 40 })
    superego.slot('composer.above', Waiting)
    superego.slot('onboarding', ClaudeFound)
    superego.settings(SECTION, ClaudeSection)
    superego.tool(AGENT_TOOL, agentRow)
    superego.tool('ExitPlanMode', planRow)
    superego.tool('AskUserQuestion', questionRow)
  },
})

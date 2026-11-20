// What Claude Code asks the user before it goes on (`canUseTool`), as the thread shows it, and the user's answer as
// Claude Code takes it back. Its questions (AskUserQuestion) go through agent-ui's question card instead (turn.ts).
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { SERVER, type Answer, type Approval } from './shared.ts'

/** How long a line about a call may be. */
const LINE = 120

const oneLine = (text: string) => {
  const line = text.trim().split('\n')[0]!.trim()
  return line.length > LINE ? `${line.slice(0, LINE - 1)}…` : line
}
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined

/** What a call acts on, in a line: its command, file, address, pattern or query. */
function subjectOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query', 'description', 'prompt']) {
    const value = str(input[key])
    if (value) return value
  }
  return undefined
}

/** A tool's name as the user reads it: an MCP server's tools by the server's name ("linear: create_issue"). */
export function toolLabel(tool: string) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!mcp) return tool
  return mcp[1] === SERVER ? mcp[2]! : `${mcp[1]}: ${mcp[2]}`
}

/** What to look at before answering: the command in full, or what goes in the file; else the input, when it has any. */
function previewOf(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Bash') return str(input.command)
  if (tool === 'Write') return str(input.content)
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits as Record<string, unknown>[] : [input]
    const diff = edits.flatMap((edit) => [
      ...String(edit.old_string ?? '').split('\n').map((line) => `- ${line}`),
      ...String(edit.new_string ?? '').split('\n').map((line) => `+ ${line}`),
    ]).join('\n')
    return diff.trim() ? diff : undefined
  }
  const keys = Object.keys(input)
  return keys.length ? JSON.stringify(input, null, 2) : undefined
}

/** The rules a set of permission updates adds, as Claude Code writes them: `Bash(npm test:*)`, a folder. */
function grants(updates: readonly PermissionUpdate[]): string[] {
  return updates.flatMap((update) => {
    if (update.type === 'addRules' && update.behavior === 'allow') return update.rules.map((r) => r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)
    if (update.type === 'addDirectories') return update.directories
    if (update.type === 'setMode') return [update.mode === 'acceptEdits' ? 'edits' : `${update.mode} mode`]
    return []
  })
}

/** "Always allow Bash(npm test:*)": what answering "always" makes Claude Code remember, where it offers that. */
export function alwaysOf(suggestions: readonly PermissionUpdate[] | undefined): string | undefined {
  if (!suggestions?.length) return undefined
  const what = grants(suggestions)
  const session = suggestions.every((s) => s.destination === 'session')
  return `Always allow${what.length ? ` ${what.join(', ')}` : ''}${session ? ' this session' : ''}`
}

/** What Claude Code asked, as the thread shows it until it's answered. */
export function approvalOf(tool: string, input: Record<string, unknown>, options: {
  toolUseID: string; suggestions?: PermissionUpdate[]; decisionReason?: string; blockedPath?: string; suppressAlwaysAllowRule?: boolean
}, thread: string, at: number): Approval {
  const base = { id: options.toolUseID, thread, at, tool }
  if (tool === 'ExitPlanMode') {
    const plan = str(input.plan)
    return { ...base, title: `Plan: ${oneLine(plan?.replace(/^#+\s*/, '') ?? 'ready')}`, ...(plan ? { plan } : {}) }
  }
  const subject = subjectOf(input)
  const preview = previewOf(tool, input)
  const reason = options.blockedPath ? `It reaches ${options.blockedPath}` : str(options.decisionReason)
  const always = options.suppressAlwaysAllowRule ? undefined : alwaysOf(options.suggestions)
  return {
    ...base,
    title: subject ? `${toolLabel(tool)}: ${oneLine(subject)}` : toolLabel(tool),
    ...(preview && preview !== subject ? { preview } : {}),
    ...(reason ? { reason } : {}),
    ...(always ? { always } : {}),
  }
}

/** The plan approved: Claude Code goes on to do it, out of plan mode (as approving one in its own UI does). */
const LEAVE_PLAN: PermissionUpdate = { type: 'setMode', mode: 'default', destination: 'session' }

/** The user's answer, as Claude Code takes it. */
export function resultOf(approval: Pick<Approval, 'tool'>, input: Record<string, unknown>, answer: Answer, suggestions: PermissionUpdate[] | undefined): PermissionResult {
  const said = answer.message?.trim()
  if (answer.choice === 'deny') {
    if (approval.tool === 'ExitPlanMode') return { behavior: 'deny', message: said ? `The user wants to keep planning: ${said}` : 'The user wants to keep planning. Ask what to change, or refine the plan.' }
    return { behavior: 'deny', message: said ? `The user denied this: ${said}` : 'The user denied this.' }
  }
  if (approval.tool === 'ExitPlanMode') {
    const modes = suggestions?.filter((s) => s.type === 'setMode') ?? []
    return { behavior: 'allow', updatedInput: input, updatedPermissions: modes.length ? modes : [LEAVE_PLAN] }
  }
  return { behavior: 'allow', updatedInput: input, ...(answer.choice === 'always' && suggestions?.length ? { updatedPermissions: suggestions.map(forNow) } : {}) }
}

/** Where Claude Code would keep an update in the folder's own settings. */
const inFolder = (update: PermissionUpdate) => update.destination === 'localSettings' || update.destination === 'projectSettings'

/**
 * What Claude Code applies of an "always" now: what it would keep in the folder's own settings, for this session
 * instead (the tool rules among it are Superego's to keep: `folderRules`, always.ts).
 */
const forNow = (update: PermissionUpdate): PermissionUpdate => inFolder(update) ? { ...update, destination: 'session' } : update

/** The tool rules an "always" would have Claude Code keep in the folder's own settings: Superego keeps them instead. */
export function folderRules(suggestions: readonly PermissionUpdate[] | undefined): string[] {
  return (suggestions ?? []).filter(inFolder).flatMap((update) => update.type === 'addRules' && update.behavior === 'allow' ? grants([update]) : [])
}

/** An AskUserQuestion question, as agent-ui's `ask_user` takes it. */
export type Question = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }

/** The questions of an AskUserQuestion call (up to four). */
export function questionsOf(input: Record<string, unknown>): Question[] {
  return (Array.isArray(input.questions) ? input.questions as Question[] : []).filter((q) => typeof q?.question === 'string')
}

/** One question as agent-ui's question card asks it: its header as context, and its options (several may be picked). */
export function askUserArgs(question: Question) {
  // The question itself is the last paragraph, as the card has it: what comes before is its context.
  const context = [question.header && `**${question.header}**`, question.multiSelect && 'Several may be picked: type them, separated by commas.'].filter(Boolean).join(' · ')
  return {
    question: `${context ? `${context}\n\n` : ''}${question.question}`,
    options: (question.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
  }
}

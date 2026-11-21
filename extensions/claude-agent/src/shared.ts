// Claude Agent: what it is, and what both halves agree on: what a thread's Claude Code waits on the user for (its
// approvals), how they're answered, and a profile's choices for it.
import type { ExtensionAbout, Json } from '@superego/protocol'

export const about = {
  name: 'claude-agent', version: '0.2.0', api: '^5.3', title: 'Claude Agent',
  description: 'Runs your Claude Code, in threads whose profile picks it (agent: \'claude-agent\').',
} satisfies ExtensionAbout

/** What each thread's Claude Code waits on the user for, oldest first: a scoped value by thread (`Approval[]`). */
export const WAITING = 'claude-agent.waiting'
/** Answer an approval, by its id: `{ id, choice, message? }`. */
export const ANSWER = 'claude-agent.answer'
/** Whether Claude Code is installed here and signed in (`ClaudeStatus`), as `claude auth status` says: for setup. */
export const STATUS = 'claude-agent.status'
/** Make the user's "claude" profile, which picks Claude Agent, unless there's one: `{ name }`. */
export const MAKE_PROFILE = 'claude-agent.makeProfile'
/** The profile setup makes. */
export const PROFILE_NAME = 'claude'
/** Claude Code here: not installed, or installed and signed in or not (`how`: its auth method, "claude.ai" say). */
export type ClaudeStatus = { installed: false } | { installed: true; loggedIn: boolean; how?: string; error?: string }

/** A profile's choices for its Claude Agent threads (`ClaudeAgentOptions`), its key in profiles. */
export const PROFILE_KEY = 'claudeAgent'
/** The MCP server Superego's tools are on, in Claude Code: its tools are `mcp__superego__<name>`. */
export const SERVER = 'superego'
/** Claude Code's tool that runs a subagent: its calls show the subagent's steps under them. */
export const AGENT_TOOL = 'Agent'

/**
 * Something Claude Code asked the user before going on (`canUseTool`): a tool call to allow, or a plan to approve.
 * `id` is the tool call's.
 */
export type Approval = {
  id: string
  thread: string
  at: number
  /** Claude Code's name for the tool. */
  tool: string
  /** In a line: "Bash: npm test". */
  title: string
  /** What the call does, to look at before answering: a command, a file and what goes in it, its input. */
  preview?: string
  /** Why Claude Code asks, when it says. */
  reason?: string
  /** "Always allow Bash(npm test:*)": what Claude Code offers to remember, when it offers it. */
  always?: string
  /** A plan to approve (ExitPlanMode), Markdown: approving it is allowing the call. */
  plan?: string
}

/** How the user answered: allow once, allow and remember (`always`), or deny; `message` says why, or what instead. */
export type Choice = 'allow' | 'always' | 'deny'
export type Answer = { choice: Choice; message?: string }

/** Permission modes a profile may pick; `bypassPermissions` only by saying so. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
/**
 * Where Claude Code reads its settings from (its `CLAUDE.md`, skills, hooks, MCP servers): the user's own, and the
 * folder's (`project`, `local`) once the user allowed them; a profile may narrow them.
 */
export const SETTING_SOURCES = ['user', 'project', 'local'] as const
export type SettingSource = (typeof SETTING_SOURCES)[number]

/** A profile's `claudeAgent`: how its Claude Agent threads run. */
export type ClaudeAgentOptions = {
  /** How Claude Code asks before using tools: `default` (ask, unless its settings allow), unless the profile says. */
  permissionMode?: PermissionMode
  /**
   * Which of its settings Claude Code reads, of those it may: `user`, and `project` and `local` once the folder's are
   * allowed. A profile narrows them; it can't add a folder's the user hasn't allowed.
   */
  settingSources?: SettingSource[]
  /** Tools Claude Code may use without asking, and tools it may not use, in its own rule syntax (`Bash(npm test:*)`). */
  allowedTools?: string[]
  disallowedTools?: string[]
}

/** What's wrong with a profile's `claudeAgent`, if anything. */
export function optionsProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `${PROFILE_KEY} must be an object`
  const known = new Set(['permissionMode', 'settingSources', 'allowedTools', 'disallowedTools'])
  for (const [key, given] of Object.entries(value)) {
    if (!known.has(key)) return `${PROFILE_KEY}.${key} isn't something it takes (${[...known].join(', ')})`
    if (key === 'permissionMode' && !(PERMISSION_MODES as readonly unknown[]).includes(given)) return `${PROFILE_KEY}.permissionMode is one of ${PERMISSION_MODES.join(', ')}`
    if (key === 'settingSources' && (!Array.isArray(given) || given.some((s) => !(SETTING_SOURCES as readonly unknown[]).includes(s)))) {
      return `${PROFILE_KEY}.settingSources is a list of ${SETTING_SOURCES.join(', ')}`
    }
    if ((key === 'allowedTools' || key === 'disallowedTools') && (!Array.isArray(given) || given.some((s) => typeof s !== 'string'))) return `${PROFILE_KEY}.${key} is a list of tool rules`
  }
  return undefined
}

/**
 * What a Claude Agent thread keeps (this extension's state with it), published by thread as a scoped value: its
 * folder's Claude Code settings as last looked at, and its subagents' work by their Agent call.
 */
export const KEPT = 'claude-agent.kept'
export type Kept = { project?: ProjectConfig; subagents?: Record<string, SubagentSteps> }

/** A subagent's work, as its Agent call shows it: how it stands, what it said and the tools it called, with their results. */
export type SubagentSteps = {
  status: 'running' | 'completed' | 'failed' | 'stopped'
  /** What it found, in a line or a few, once it ended. */
  summary?: string
  /** When it was last heard from: the thread keeps its newest few. */
  at?: number
  steps: ({ type: 'text'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, Json> })[]
  results: Record<string, { text: string; isError: boolean }>
}

/**
 * A folder's Claude Code configuration as it is now: its files (from the folder, or absolute when above it), and their
 * hash. `onlyInstructions`: all of it is instructions (`CLAUDE.md`, what it imports, rules), no settings. `unsafe`: a
 * folder or file Claude Code takes it from that another user could change, so it can't be allowed.
 */
export type ProjectConfig = { cwd: string; files: string[]; hash: string; onlyInstructions: boolean; unsafe?: string }

/** What a Claude Agent thread says of its folder's own Claude Code configuration, when it has some (its facts). */
export type ProjectFacts = ProjectConfig & {
  /** Allowed as it is: its turns load it. */
  allowed: boolean
  /** Allowed before, and changed since. */
  changed: boolean
}

/** The action allowing a folder's Claude Code configuration, as it is now (or at `hash`, the one shown). */
export const ALLOW = 'claude-agent.allow'

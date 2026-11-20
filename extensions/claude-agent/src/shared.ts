// Claude Agent: what it is, for the daemon and for where extensions are listed.
export const about = {
  name: 'claude-agent', version: '0.1.0', api: '^5.3', title: 'Claude Agent',
  description: 'Runs your Claude Code, in threads whose profile picks it (agent: \'claude-agent\').',
}

/**
 * A folder's Claude Code configuration as it is now: its files (from the folder, or absolute when above it), and their
 * hash. `unsafe`: a folder or file Claude Code takes it from that another user could change, so it can't be allowed.
 */
export type ProjectConfig = { cwd: string; files: string[]; hash: string; unsafe?: string }

/** What a Claude Agent thread says of its folder's own Claude Code configuration, when it has some (its facts). */
export type ProjectFacts = ProjectConfig & {
  /** Allowed as it is: its turns load it. */
  allowed: boolean
  /** Allowed before, and changed since. */
  changed: boolean
}

/** The action allowing a folder's Claude Code configuration, as it is now (or at `hash`, the one shown). */
export const ALLOW = 'claude-agent.allow'

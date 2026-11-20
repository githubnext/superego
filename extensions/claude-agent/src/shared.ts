// Claude Agent: what it is, for the daemon and for where extensions are listed.
export const about = {
  name: 'claude-agent', version: '0.1.0', api: '^5.3', title: 'Claude Agent',
  description: 'Runs your Claude Code, in threads whose profile picks it (agent: \'claude-agent\').',
}

/** What a Claude Agent thread says of its folder's own Claude Code configuration, when it has some (its facts). */
export type ProjectFacts = {
  cwd: string
  /** Its files: from the folder, or absolute when above it. */
  files: string[]
  hash: string
  /** Allowed as it is: its turns load it. */
  allowed: boolean
  /** Allowed before, and changed since. */
  changed: boolean
  /** A folder or file it's loaded from that another user could change: it can't be allowed. */
  unsafe?: string
}

/** The action allowing a folder's Claude Code configuration, as it is now (or at `hash`, the one shown). */
export const ALLOW = 'claude-agent.allow'

# Claude Agent (experimental)

A Claude Agent thread runs your own installed Claude Code (`claude`) instead of Superego's agent, on Claude Code's own
sign-in. Superego keeps the rest: the transcript, status, panes, notifications, phone and web access, and other
machines. Superego doesn't install, update or sign in to Claude Code, and never reads its credentials.

## Starting one

You need Claude Code installed on the thread's machine and signed in there (`claude`, then `/login`). Then either:

- pick one of the Claude Agent models in the New thread dialog (Opus, Sonnet or Haiku, with Claude Code's effort
  levels as thinking). The thread starts with your `claude` profile, which first-run model setup or the first such
  thread makes: `{ agent: 'claude-agent' }`;
- or start a thread with any profile that says `agent: 'claude-agent'`.

A thread stays a Claude Agent thread for its whole life: the two kinds keep different histories.

Settings → Claude Agent shows the machine's Claude Code and how it's signed in. Signed out, Open a terminal runs
`claude` beside the thread for you to `/login`; a thread whose turn failed for it goes on once Check again finds it
signed in.

## What it gets

- **Superego's tools over MCP:** starting, reading and messaging threads, panes, questions and UI, images and tasks. The
  profile's `prompt` is appended to Claude Code's own.
- **Claude Code's own settings,** skills, hooks and MCP servers from `~/.claude`.
- **A folder's settings** (`.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`) only once you allow them, since their
  hooks, MCP servers and permissions run commands. The thread asks over its message box, and again after they change.
  From a terminal: `superego do claude-agent.allow --cwd "$PWD"`.
- **The `superego` skill,** and `superego` in its shell, acting as its thread.

What it doesn't get: Superego's models, its compaction, its coding tools (Claude Code has its own), and other
extensions' tools and hooks. Its MCP servers are Claude Code's, not the ones in Settings → MCP servers.

## Permissions

When Claude Code asks to use a tool, the thread shows as blocked, with Allow, Deny and, where Claude Code offers one,
Always allow. Always allow is kept per folder by Superego. Claude Code's questions and plans show the same way.

Settings → Claude Agent:

- **Permission mode:** for threads whose profile doesn't pick one. Ask before tools it isn't allowed (`default`),
  Accept edits, Plan first, or Auto.
- **Threads at once:** how many work at the same time on this machine (default 3); the rest wait their turn.

When Claude Code warns of a plan's rate limit, a line over the message box says how much is used and when it resets.

## In a profile

```ts
import { defineProfile } from 'superego'
export default defineProfile({
  agent: 'claude-agent',
  prompt: 'Work in small commits.',
  claudeAgent: { permissionMode: 'acceptEdits', model: 'sonnet', effort: 'high' },
})
```

`claudeAgent` takes `permissionMode` (also `bypassPermissions`, only from a profile), `settingSources` (Claude Code's
`user`, `project`, `local`, to narrow what it loads), `allowedTools`, `disallowedTools`, `model` and `effort`. See
[Profiles](../packages/cli/skill/profiles.md#when-changes-apply).

## The binary and its environment

The daemon runs the `claude` on the machine's login shell's `PATH`, or `SUPEREGO_CLAUDE`. It passes Claude Code the
daemon's environment without Anthropic and Claude Code credentials (`ANTHROPIC_API_KEY` and the like), so it uses its
own sign-in and doesn't bill an API key you didn't pick.

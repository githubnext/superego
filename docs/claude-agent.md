# Claude Agent (experimental)

A Claude Agent thread runs your installed Claude Code (`claude`) instead of Superego's agent, on Claude Code's own
sign-in, with Superego's transcript, panes, notifications and machines around it. Superego never reads its
credentials.

## Start one

Install Claude Code on the thread's machine and sign in there (`claude`, then `/login`). Then either:

- pick a Claude Agent model in New thread (Opus, Sonnet or Haiku; thinking is Claude Code's effort level). It runs on
  your `claude` profile, `{ agent: 'claude-agent' }`, made by model setup or the first such thread;
- or start a thread with any profile that says `agent: 'claude-agent'`.

A thread stays a Claude Agent thread for life.

Settings → Claude Agent shows how the machine's Claude Code is signed in. Signed out, Open a terminal runs `claude`
beside the thread for you to `/login`; Check again resumes a turn that failed for it. If Claude Code is your default
and gets signed out or uninstalled, New thread says so and offers Set up models….

## What it gets

- Superego's thread, pane, question, UI, image and task tools, over MCP; the profile's `prompt`, after Claude Code's.
- Claude Code's own settings, skills, hooks and MCP servers (`~/.claude`), not those in Settings → MCP servers.
- The `superego` skill, and `superego` in its shell, acting as its thread.
- A folder's `.claude/`, `.mcp.json`, `CLAUDE.md` and `CLAUDE.local.md` once you allow them (the thread asks, and again
  after they change), since they can run commands. From a terminal: `superego do claude-agent.allow --cwd "$PWD"`.

Not Superego's models, compaction or coding tools, nor other extensions' tools and hooks.

## Permissions

A tool request, question or plan blocks the thread, with Allow, Deny and, where offered, Always allow (kept per
folder). A rate-limit warning shows over the message box.

Settings → Claude Agent:

| Setting | |
|---|---|
| Permission mode | for threads whose profile doesn't pick one: Ask (`default`), Accept edits, Plan first, Auto |
| Threads at once | how many run at once on this machine (default 3); the rest wait |

## In a profile

```ts
import { defineProfile } from 'superego'
export default defineProfile({
  agent: 'claude-agent',
  prompt: 'Work in small commits.',
  claudeAgent: { permissionMode: 'acceptEdits', model: 'sonnet', effort: 'high' },
})
```

| `claudeAgent` key | |
|---|---|
| `permissionMode` | `default`, `acceptEdits`, `plan`, `auto`, or `bypassPermissions` (profile only) |
| `settingSources` | Claude Code's `user`, `project`, `local`: narrows what it loads |
| `allowedTools`, `disallowedTools` | Claude Code's tool lists |
| `model`, `effort` | an alias or id; `low` … `max` |

See [Profiles](../packages/cli/skill/profiles.md#claude-agent).

## The binary and its environment

The daemon runs the `claude` on the login shell's `PATH`, or `SUPEREGO_CLAUDE`. It passes the daemon's environment
without Anthropic and Claude Code credentials (`ANTHROPIC_API_KEY` and the like), so Claude Code uses its own sign-in.

# Thread tools

An agent hands work to other threads with the thread tools (the bundled `thread-tools` extension). A thread it starts
reports back when done (`thread-reports`) and can work in a git worktree of its own (`worktrees`).
`without: ['thread-tools']` removes the tools; `without: ['thread-reports']` keeps them, without reports.

## The tools

| Tool | Parameters | Does |
|---|---|---|
| `thread_start` | `prompt` (its first message), `title`, `cwd`, `profile`, `worktree`, `machine` | starts a child, nested under this thread in the sidebar. Answers its link and id |
| `thread_read` | `thread`, `wait`, `machine` | its status, folder, who started it, its children, and its last answer (clipped at 6,000 characters). `wait: true` waits until it isn't working (its run ended, or it needs the user); Stop ends the wait. A thread can't wait on itself |
| `thread_send` | `thread`, `text`, `machine` | a message signed `From [this thread](thread:<id>):`, delivered when that thread is next free |
| `thread_list` | `machine` | this thread's parent, its children and the other threads in its project, with status and folder. On another machine, its newest 30 |
| `thread_archive` | `thread` (default: this one) | puts a thread away and says what that did ([below](#archiving)). Archiving this thread waits until this turn ends |
| `thread_machines` | none | the other machines this one reaches, for `machine` |

`thread` is an id, from `thread_start` or `thread_list`. In a message, `[its title](thread:<id>)` links to the thread.

From an extension: `superego.threads` (`start({ prompt, cwd, profile, parent, options })`, `send`, `lastAnswer`,
`idle`, `archive`; [cheat sheet](cheatsheet.md)). A worktree there is `options: { worktrees: true }`, which is what
`worktree: true` sends.

## What a child gets

| | |
|---|---|
| Context | its prompt only: nothing of its parent's conversation |
| Folder | `cwd`, else its parent's (a parent's worktree included) |
| Profile | `profile`, else the folder's `default` (the project's, else yours, else none). Never its parent's. A project's profile must be allowed first |
| Worktree | `worktree: true`: branch `superego/<slug>` from the folder's HEAD, in `~/.superego/worktrees/<repo>/<slug>`. Left out, its profile's `options` decide; `worktree: false` overrides them. Outside git, the folder |
| Model | its profile's, else the machine's default |

With `machine`, it starts on that machine (in `cwd` there, or its default folder) as nobody's child: not nested, no
reports. Read it with `thread_read` and the same `machine`.

## Reports

When a child's run ends, or it stops to ask the user something, its parent gets a message:

```text
From [Fix the login form](thread:812): finished.

The form now validates on blur; tests in login.test.ts.
```

- `finished`, `replied` (to the parent's `thread_send`), `errored (…)`, or `is waiting on a question` with the
  question. The answer is cut to 6 lines (600 characters); `thread_read` has the rest.
- A report starts a parent's turn, so a parent can start its children and end its turn. Reports close together go as
  one; while the parent runs, they wait until it ends.
- No report if the parent has read the child since (`thread_read`, its wait too), or the child was archived.
- A child reports what it does for its parent (its prompt, each `thread_send`). Once the user writes to it, that
  conversation is theirs and isn't reported.
- Grandchildren report to their parent, whose run then reports up.
- While its parent hears it, a child is quiet: its finishing isn't unread or notified (needing the user still is).
  Once the parent is archived, the child notifies for itself.
- A hidden thread's child (an extension's own agent's, like Ego's) reports to it, but shows top-level in the sidebar
  and isn't quiet.
- The child is told its answer goes to its parent, outcome first.
- Best effort: a report waiting to go is lost if the daemon restarts. To be sure a child finished, `thread_read` it.

## Archiving

`thread_archive` takes a thread out of the sidebar. It takes no messages until unarchived; its children stay as they
are.

- Refused while it's working or waiting on a question: `thread_read` with `wait: true` first.
- **Worktree:** removed if nothing in it is uncommitted, after stopping processes still running from it. Otherwise the
  worktree and branch are kept.
- **Branch:** once the worktree is gone, deleted if merged into the main checkout's branch (or its upstream), else
  kept. The thread remembers its tip either way.
- The answer says which: `Archived [Fix the login form](thread:812). Removed the worktree
  ~/.superego/worktrees/app/fix-the-login-form-3fa2c1; branch superego/fix-the-login-form-3fa2c1 kept: not merged.`
- Unarchiving puts the worktree back on its branch, recreated at its tip if it was deleted.

So merge a child's branch before archiving it.

## A lead profile

An agent that splits a task, hands out the parts and reviews them, writing no code itself. Its builders run the
folder's `default` profile.

```ts
// .superego/profiles/lead/profile.ts
import { defineProfile } from 'superego'

export default defineProfile({
  description: 'Splits a change into parts, hands them out and reviews them',
  prompt: `You lead a change. You don't write the code: threads you start do.

1. Split the task into parts that can go on side by side.
2. Start a thread for each with thread_start and worktree: true. Its prompt is all it sees: the goal, the files
   involved, how to check its work, and to commit on its branch when done.
3. End your turn. Each thread reports back when it finishes or has a question, and that starts your next turn.
4. Review each report. thread_read gives the whole answer and the thread's folder; read its diff there
   (git -C <folder> diff main...HEAD). Ask for fixes with thread_send.
5. When a part is good, merge its branch into main, then archive the thread with thread_archive.
6. Once every part is merged and the checks pass, say what was built.`,
})
```

- Start it with `superego -P lead -p "…"` or from New thread. The user allows it first (`superego profile allow lead`).
- For builders of their own, write a `builder` profile and have the prompt pass `profile: "builder"` to thread_start.
- The lead's `options: { worktrees: true }` gives only its own threads worktrees; children follow their own profile or
  `worktree`.

# Thread tools

An agent hands work to other threads with the thread tools (the bundled `thread-tools` extension). A thread it starts
reports back when it's done (`thread-reports`), and can work in a git worktree of its own (`worktrees`). A profile
`without: ['thread-tools']` has none of the tools; `without: ['thread-reports']` keeps them, with no reports either way.

## The tools

| Tool | Parameters | What it does |
|---|---|---|
| `thread_start` | `prompt` (its first message), `title`, `cwd`, `profile`, `worktree`, `machine` | Starts a child: a thread nested under this one in the sidebar, with an agent of its own. Answers its link and id. |
| `thread_read` | `thread`, `wait`, `machine` | Where a thread stands (status, folder), who started it, its children, and its last answer (clipped at 6,000 characters). `wait: true` waits until it isn't working: its run ended, or it needs the user. Stop ends the wait. A thread can't wait on itself. |
| `thread_send` | `thread`, `text`, `machine` | A message, signed `From [this thread](thread:<id>):`, that goes in when that thread is next free. |
| `thread_list` | `machine` | This thread's parent, its children and the other threads in its project, each with its status and folder. On another machine, its newest 30. |
| `thread_archive` | `thread` (this one if left out) | Puts a thread away, and says what that did (below). Archiving this thread waits until this turn ends. |
| `thread_machines` | none | The other machines this one reaches, for `machine`. |

`thread` is an id: `thread_start` and `thread_list` give them. In a message, `[its title](thread:<id>)` shows as a
link to the thread.

Extensions do the same from code with `superego.threads` (`start({ prompt, cwd, profile, parent, options })`, `send`,
`lastAnswer`, `idle`, `archive`: [cheat sheet](cheatsheet.md)). There a worktree is asked for as
`options: { worktrees: true }`, which is what the tool's `worktree: true` sends.

## What a child gets

- **Its prompt, and nothing else.** It sees nothing of its parent's conversation: the prompt says everything it needs.
- **A folder:** `cwd`, else its parent's folder. A parent in a worktree starts its children in that worktree.
- **A profile:** the one `profile` names, else the folder's `default` (the project's, else yours, else none). Never its
  parent's: a thread on a `lead` profile starts `default` threads unless it names another. A project's profile has to be
  allowed first.
- **A worktree,** when `worktree: true`: a new branch, `superego/<slug>`, from the HEAD of the folder it starts in,
  checked out in `~/.superego/worktrees/<repo>/<slug>`. Left out, its profile's `options` decide, so `worktree: false`
  keeps a child in the folder when its profile would give it one. Outside a git repository it works in the folder.
- **Its model** from its profile, else the machine's default.

With `machine`, it starts on that machine, in `cwd` there or that machine's default folder. It's nobody's child there:
not nested, no reports. Read it with `thread_read` and the same `machine`.

## Reports

When a child's run ends, or it stops to ask the user something, its parent gets a message from it:

```text
From [Fix the login form](thread:812): finished.

The form now validates on blur; tests in login.test.ts.
```

- It says `replied` for a run that answered the parent's `thread_send`, `errored (…)` for a failure, and `is waiting on
  a question` with the question. The answer is cut to its first 6 lines (600 characters); `thread_read` has the rest.
- The message starts a turn of the parent's, like any other. So a parent can start its children and end its turn: each
  report wakes it. Reports close together go as one message, and while the parent is in a run they wait until it ends.
- A report isn't sent when the parent has read that child since (`thread_read`, its wait too), or the child was archived.
- A child reports while it works for its parent: from its prompt, and from each `thread_send` of the parent's. Once the
  user writes to it, it's theirs, and that conversation isn't reported.
- A child's own children report to it, and its run then reports up, so a grandchild's result reaches the top.
- While its parent hears it, a child is quiet: its finishing isn't unread or notified (needing the user still is). Once
  the parent is archived, the child notifies for itself.
- The child is told its answer goes to its parent, and to put the outcome first.
- Reports are best effort: one waiting to go is lost if the daemon restarts. A workflow that must know a child finished
  asks it with `thread_read`.

## Archiving

`thread_archive` takes a thread out of the sidebar. It takes no messages until it's unarchived, and its children are
left as they are.

- It refuses a thread that's working or waiting on a question: `thread_read` with `wait: true` first.
- **Its worktree** is removed if nothing in it is uncommitted, after stopping any processes still running from it. With
  uncommitted changes, the worktree and its branch are both kept.
- **Its branch,** once the worktree is removed, is deleted if it's merged into the branch the main checkout is on (or
  that branch's upstream), and kept if not. The thread remembers its tip either way.
- The tool's answer says which, for example: `Archived [Fix the login form](thread:812). Removed the worktree
  ~/.superego/worktrees/app/fix-the-login-form-3fa2c1; branch superego/fix-the-login-form-3fa2c1 kept: not merged.`
- Unarchiving puts the worktree back on its branch, made again at the tip it had if archiving deleted it.

So merge a child's branch before archiving it, or its branch stays.

## A lead profile

A profile whose agent splits a task, hands the parts out, and reviews what comes back. It writes no code itself; its
builders run the folder's `default` profile.

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

- Start it with `superego -P lead -p "…"`, or pick it in the New thread dialog. A project's profile runs once the user
  allows it (`superego profile allow lead`).
- For builders of their own, write a `builder` profile and have the prompt pass `profile: "builder"` to thread_start.
- A profile's `options: { worktrees: true }` gives its own threads worktrees, not the threads they start: their
  profile's `options`, or `worktree`, decide.

// The header scene's script (test/header.mjs, run by `test/look.sh <dir> header`): the README's header and the site's
// link preview. A few threads in three projects, each where the scene wants it: the one shown builds Ledger's home page
// (a task's steps, a word and a code block) and puts it in a Browser pane beside it; one is still at it (a long
// `sleep`), one waits on a question, one is done and not yet read, the rest are done. Every turn names the thread it's for (replay.ts's `thread`:
// text from that thread's first message). `node header.mjs <turns.jsonl>` writes the replay file.
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const text = (t) => ({ type: 'text', text: t })
let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `call-${++ids}`, name, arguments: args })
const turn = (thread, content) => ({ thread, content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' })
let task
const start = (title) => (task = call('task_start', { title }))
const finish = (outcome) => call('task_finish', { task_id: task.id, status: 'success', outcome })

/** Where the scene serves the shown thread's project (its `site/`), for the Browser pane. */
export const PORT = 4317

/**
 * The threads, by project (a folder of that name), in the order they're started, and the state each is left in; the one
 * shown is sent a follow-up after.
 */
export const THREADS = [
  { project: 'atlas', title: 'Upgrade to Node 24', prompt: 'Upgrade the project to Node 24 and fix whatever breaks.', state: 'done' },
  { project: 'field-notes', title: 'Release notes for 2.4', prompt: 'Draft the release notes for 2.4 from the merged pull requests.', state: 'blocked' },
  { project: 'atlas', title: 'Tiles load twice', prompt: 'Map tiles load twice when you zoom in quickly. Find out why.', state: 'done', unread: true },
  { project: 'ledger', title: 'Add --dry-run to import', prompt: 'Add a --dry-run flag to the import command: show what would be saved, write nothing.', state: 'done' },
  { project: 'ledger', title: 'Spending by category', prompt: 'Group the monthly totals by category, from the rules in categories.json.', state: 'working' },
  { project: 'ledger', title: 'A home page for Ledger', prompt: 'Give Ledger a home page in site/: plain HTML and one stylesheet, no framework. Show it to me when it\'s up.', state: 'done', shown: true,
    followUp: { text: 'Yes please, and leave the README as it is.', state: 'working' } },
]
const key = (title) => THREADS.find((t) => t.title === title).prompt

const INDEX = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledger</title>
<link rel="stylesheet" href="style.css">
<header><b>Ledger</b> <nav><a href="docs/">Docs</a> <a href="https://github.com">Source</a></nav></header>
<main>
  <h1>Your bank exports, totalled by month.</h1>
  <p>Ledger reads the CSV files your bank gives you and tells you where the money went. No account, no cloud.</p>
  <pre><code>$ ledger import november.csv
Imported 214 rows.

Month       Spent      Earned
October   1,204.50   3,100.00
November    987.10   3,200.00</code></pre>
  <p><a class="button" href="docs/">Get started</a></p>
</main>
<footer>Open source, MIT licensed.</footer>
`
const STYLE = `:root { font: 17px/1.55 system-ui, sans-serif; color: #1d1d1f; background: #fbfaf7; }
header, main, footer { max-width: 38rem; margin: 0 auto; padding: 1.25rem 1.5rem; }
header { display: flex; justify-content: space-between; }
nav a { margin-left: 1rem; color: inherit; text-decoration: none; }
h1 { font-size: 2.4rem; line-height: 1.1; letter-spacing: -0.02em; margin: 2rem 0 1rem; }
pre { background: #f0eee8; padding: 1rem 1.25rem; border-radius: 10px; font-size: 0.8rem; }
.button { display: inline-block; padding: 0.5rem 1rem; border-radius: 999px; background: #2f6f4f; color: white; text-decoration: none; }
footer { color: #6e6e73; font-size: 0.85rem; }
@media (prefers-color-scheme: dark) {
  :root { color: #ececec; background: #1c1c1e; }
  pre { background: #2a2a2d; }
  .button { background: #3d8c63; }
  footer { color: #8e8e93; }
}
`

const home = key('A home page for Ledger')
export const turns = [
  // ── The thread shown: a task's steps, then the page beside it ────────────────────────────────────────────────────
  turn(home, [start('Building the home page'), call('read', { path: 'README.md' })]),
  turn(home, [call('bash', { command: `mkdir -p site && cat > site/index.html <<'EOF'\n${INDEX}EOF\ncat > site/style.css <<'EOF'\n${STYLE}EOF\nls site` })]),
  turn(home, [call('pane_open', { kind: 'browser', params: { url: `http://localhost:${PORT}/` } })]),
  turn(home, [finish('The home page and its stylesheet in site/.')]),
  turn(home, [text(`It's up, beside this thread: \`site/index.html\` and one stylesheet, nothing to build.

The page leads with what Ledger does, then shows it at work, from the README's own example:

\`\`\`css
h1 { font-size: 2.4rem; letter-spacing: -0.02em; }
pre { background: #f0eee8; border-radius: 10px; }
.button { border-radius: 999px; background: #2f6f4f; }
\`\`\`

The **Docs** link points at \`site/docs/\`, which doesn't exist yet. Want me to turn the README into those pages next?`)]),
  // The follow-up: still at it when the window's shot (a long wait, the scene ends it).
  turn(home, [start('Turning the README into docs'), call('read', { path: 'README.md' })]),
  turn(home, [call('bash', { command: 'mkdir -p site/docs && sleep 1200' })]),

  // ── The rest, each where the scene wants it ──────────────────────────────────────────────────────────────────────
  turn(key('Upgrade to Node 24'), [text('On Node 24 now: `engines` and `.nvmrc` bumped, and the one test that leaned on the old `url.parse` fixed. All 86 tests pass.')]),
  turn(key('Release notes for 2.4'), [
    text('Eleven pull requests since 2.3. Before I write them up:'),
    call('ask_user', {
      question: 'Lead with the new offline mode, or with the sync fixes most people asked for?',
      options: [{ label: 'Offline mode' }, { label: 'The sync fixes' }],
    }),
  ]),
  turn(key('Tiles load twice'), [text('Found it: each zoom step cancels its tile requests a frame too late, so both levels load. Cancelling on `zoomstart` instead halves the requests; the fix is on my branch.')]),
  turn(key('Add --dry-run to import'), [text('`ledger import sample.csv --dry-run` lists the rows it would save and writes nothing. Flags can go anywhere on the line.')]),
  turn(key('Spending by category'), [text('Reading the rules in `categories.json`.'), call('bash', { command: 'sleep 1200' })]),
]

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(process.argv[2], turns.map(({ thread, ...message }) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', thread, message: { role: 'assistant', ...message } })).join('\n') + '\n')
}

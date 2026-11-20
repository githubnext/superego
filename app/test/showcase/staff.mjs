// The staff scene's script (test/staff.mjs, run by `test/look.sh <dir> staff`): a lead on the chief-of-staff profile
// (test/showcase/profiles) running a small programme through three children, in the showcase project (ledger). Every
// turn names the thread it's for (replay.ts's `thread`: text from that thread's first message), so the lead and its
// children, running at once, each take their own. Tool calls run for real: the children write and commit in their
// worktrees, one waits on a question, one is still at it (a long `sleep`), and the board shows what the lead's
// board_plan and board_ask put there, naming the children by id as thread_start's results gave them (`{{thread:…}}`). `node staff.mjs <turns.jsonl>` writes the replay file.
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const text = (t) => ({ type: 'text', text: t })
const thinking = (t) => ({ type: 'thinking', thinking: t })
let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `call-${++ids}`, name, arguments: args })
const turn = (thread, content) => ({ thread, content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' })

/** The threads the scene makes before the lead, so the project has a history; no turns. */
export const EARLIER = ['Fix the date parsing in the importer', 'Add --dry-run to import']
export const LEAD = 'Ship the public site'
/** The user's request: the lead's first message. */
export const REQUEST = 'Let\'s give Ledger a public site: a home page, the docs from the README, and a way to publish it on GitHub Pages. Plain HTML, no framework. Run it through threads; I\'m around for decisions.'

/** Each child: its title, its brief, and a phrase from the brief its turns are found by. */
export const CHILDREN = {
  home: {
    title: 'Home page and layout',
    key: 'Build the home page',
    prompt: 'Build the home page for Ledger\'s public site in `site/`: plain HTML and one stylesheet, no framework. Ledger reads bank CSV exports and totals them by month; README.md says what it does and how to run it. ' +
      'The docs pages (site/docs/, another thread) will share your stylesheet, so keep it to a header, a main column and a footer. Done means site/index.html and site/style.css committed on your branch; see AGENTS.md for the checks.',
  },
  docs: {
    title: 'Docs from the README',
    key: 'Turn README.md into the docs',
    prompt: 'Turn README.md into the docs pages of Ledger\'s public site: one page a section, in site/docs/, linking site/style.css (the home page thread writes it). Leave the README itself alone. ' +
      'Done means the pages committed on your branch, and anything in the README you found out of date, listed.',
  },
  deploy: {
    title: 'Deploy to GitHub Pages',
    key: 'Set up publishing',
    prompt: 'Set up publishing Ledger\'s public site (site/, being built in other threads) to GitHub Pages. Don\'t push or change the repository\'s settings: commit what\'s needed on your branch and say what the user has to switch on.',
  },
}

const lead = REQUEST.slice(0, 40)
const { home, docs, deploy } = CHILDREN
const commit = (message) => `git add -A && git -c user.name=Ledger -c user.email=dev@ledger.invalid commit -qm ${JSON.stringify(message)} && git log --oneline -1`

const INDEX = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledger</title>
<link rel="stylesheet" href="style.css">
<header><a href="./">Ledger</a> <nav><a href="docs/">Docs</a></nav></header>
<main>
  <h1>Your bank exports, totalled by month.</h1>
  <p>Ledger reads the CSV files your bank gives you and tells you where the money went. No account, no cloud.</p>
  <pre><code>node src/cli.mjs import november.csv</code></pre>
</main>
<footer>Ledger is open source.</footer>
`
const STYLE = `:root { font: 17px/1.55 system-ui, sans-serif; color: #1d1d1f; background: #fbfaf7; }
header, main, footer { max-width: 42rem; margin: 0 auto; padding: 1.5rem; }
header { display: flex; justify-content: space-between; font-weight: 600; }
h1 { font-size: 2.2rem; line-height: 1.15; letter-spacing: -0.02em; }
pre { background: #f0eee8; padding: 1rem; border-radius: 6px; overflow-x: auto; }
footer { color: #6e6e73; font-size: 0.85rem; }
`
const PAGES = ['getting-started', 'importing', 'reports']
const docsPages = PAGES.map((page) => `cat > site/docs/${page}.html <<'EOF'
<!doctype html>
<meta charset="utf-8">
<title>Ledger: ${page.replace('-', ' ')}</title>
<link rel="stylesheet" href="../style.css">
<main><h1>${page.replace('-', ' ')}</h1></main>
EOF`).join('\n')

export const turns = [
  // ── The lead: the request, three children, the board ─────────────────────────────────────────────────────────────
  turn(lead, [
    thinking('Three parts that don\'t touch each other\'s files: the home page and its stylesheet, the docs pages (which only link the stylesheet), and the publishing setup. One wave, three lanes, each in a worktree. A review pass once they land.'),
    text('Three lanes that don\'t overlap: the home page, the docs, and publishing. Each in a worktree of its own.'),
    call('thread_start', { title: home.title, prompt: home.prompt, worktree: true }),
  ]),
  turn(lead, [call('thread_start', { title: docs.title, prompt: docs.prompt, worktree: true })]),
  turn(lead, [call('thread_start', { title: deploy.title, prompt: deploy.prompt, worktree: true })]),
  turn(lead, [
    call('board_plan', {
      title: 'Public site',
      summary: 'Wave 1 is building the home page, the docs and publishing; a review pass once they land.',
      waves: [{ title: 'Build', lanes: [home, docs, deploy].map((c) => `{{thread:${c.title}}}`) }, { title: 'Review', lanes: ['Review pass: links, copy, phones'] }],
    }),
    call('board_ask', {
      question: 'Where should the site live?',
      options: [
        { label: 'ledger.dev', description: 'Our own domain: a DNS record to add' },
        { label: 'The GitHub Pages address', description: 'Nothing to set up; can move later' },
      ],
      about: [`{{thread:${deploy.title}}}`],
    }),
    call('pane_open', { kind: 'staff-board' }),
    call('check_in', { minutes: 25, note: 'Look over wave 1' }),
  ]),
  turn(lead, [text('All three are running. The board has the plan, and one question for you when you have a moment: where the site lives. I\'ll look in again in 25 minutes.')]),
  // Both reports, as one message: the docs' finding is the user's to decide before merging.
  turn(lead, [
    text('**Docs from the README** is done, on its branch. **Deploy to GitHub Pages** asks how to publish: it\'s on the board with the domain question.'),
    call('ask_user', {
      question: 'Before I merge the docs: the README says to install with `npm i ledger-cli`, but the package is `ledger`. Fix the README as well, or only the docs pages?',
      options: [{ label: 'Fix both', description: 'One commit on the docs branch' }, { label: 'Only the docs pages' }],
    }),
  ]),

  // ── Home page: writes and commits, then still at it ──────────────────────────────────────────────────────────────
  turn(home.key, [
    text('Writing the page and its stylesheet.'),
    call('bash', { command: `mkdir -p site && cat > site/index.html <<'EOF'\n${INDEX}EOF\ncat > site/style.css <<'EOF'\n${STYLE}EOF\n${commit('Site: the home page and its stylesheet')}` }),
  ]),
  // Still working when the window's shot: a long wait (the scene ends it).
  turn(home.key, [
    text('Checking it at a phone\'s width.'),
    call('bash', { command: 'sleep 1200' }),
  ]),

  // ── Docs: done ───────────────────────────────────────────────────────────────────────────────────────────────────
  turn(docs.key, [
    call('bash', { command: `mkdir -p site/docs\n${docsPages}\n${commit('Site: the docs, a page a README section')}` }),
  ]),
  turn(docs.key, [text(`Docs are in \`site/docs/\`: **Getting started**, **Importing** and **Reports**, one page each from the README's sections, linking the home page's stylesheet. Committed on my branch.

Out of date in the README: the install line says \`npm i ledger-cli\`; the package is \`ledger\`. I left the README alone.`)]),

  // ── Deploy: a question for the user, after the docs (so the lead hears them in that order) ───────────────────────────
  turn(deploy.key, [call('bash', { command: 'sleep 2; ls -a && git log --oneline -3' })]),
  turn(deploy.key, [
    text('Two ways to publish, and it\'s your call which.'),
    call('ask_user', {
      question: 'Publish with a GitHub Actions workflow on every push to main, or from a gh-pages branch pushed by hand at release?',
      options: [{ label: 'Actions workflow', description: 'Live minutes after a merge' }, { label: 'gh-pages branch', description: 'Only when we release' }],
    }),
  ]),
]

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(process.argv[2], turns.map(({ thread, ...message }) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', thread, message: { role: 'assistant', ...message } })).join('\n') + '\n')
}

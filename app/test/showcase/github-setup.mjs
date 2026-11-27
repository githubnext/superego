// The github scene's world (test/github.mjs, run by `test/look.sh <dir> github`): a fake gh (../../../extensions/github/
// test/fake-gh.cjs) on a PATH of its own, answering for acme/ledger's pull requests in every state (and later, the one
// the thread opens with its checks failed and changes asked for), and the turns of the thread that opens one. `node github-setup.mjs <home> <turns.jsonl>` writes <home>/gh/bin/gh, <home>/gh/github.json and
// the turns.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [home, turnsFile] = process.argv.slice(2)
const dir = join(home, 'gh')
mkdirSync(join(dir, 'bin'), { recursive: true })
const script = resolve(import.meta.dirname, '../../../extensions/github/test/fake-gh.cjs')
writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(dir)} "$@"\n`)
chmodSync(join(dir, 'bin', 'gh'), 0o755)

/** The prompt of the thread that opens #418, by which its turns name it (replay.ts's `thread`; github.mjs starts it). */
const OPENS = 'Open a PR for this.'
const URL = (n) => `https://github.com/acme/ledger/pull/${n}`
const at = (minutes) => new Date(Date.UTC(2026, 6, 1, 14, 0) + minutes * 60_000).toISOString()
const run = (name, conclusion, started, seconds, job) => ({
  __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, startedAt: at(started),
  completedAt: conclusion ? new Date(Date.parse(at(started)) + seconds * 1000).toISOString() : null, detailsUrl: `https://github.com/acme/ledger/actions/runs/${job}/job/${job + 1}`,
})
const passing = [run('typecheck', 'SUCCESS', 0, 72, 9001), run('lint', 'SUCCESS', 0, 38, 9003), run('test (macos-latest)', 'SUCCESS', 0, 302, 9005), run('build', 'SUCCESS', 0, 130, 9007)]
const pr = (number, title, more = {}, checks = passing) => ({
  number, title, url: URL(number), state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED',
  headRefName: `superego/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`, baseRefName: 'main', headRefOid: 'a1f3c9e5b2d4417a9c0e6f3b8d2a1c4e5f607182',
  author: { login: 'mikker' }, latestReviews: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
  ...more,
})
const comment = (path, line, who, body, outdated = false) => ({ isResolved: false, isOutdated: outdated, path, line, comments: { nodes: [{ author: { login: who }, body, url: `${URL(418)}#discussion_r${line}` }] } })

const prs = {
  'acme/ledger#418': pr(418, "Mentions of extensions' things: @<kind>:<id>", {
    headRefName: 'superego/mentions-ext', reviewDecision: 'CHANGES_REQUESTED',
    // Its description and conversation (asked for by the pane only).
    body: [
      "Extensions can now be mentioned in the composer: type `@` and pick one of an extension's things (a ticket, a page, a thread), and it goes into the message as `@<kind>:<id>`, drawn as a link.", '',
      '## What changes', '',
      '- `composer.mention` lets an extension offer things to mention, searched as you type',
      '- Mentions are drawn as links in messages, opening what they name',
      '- Lists are cached per source; searches debounced by 120ms', '',
      '## Testing', '',
      '- [x] `pnpm vitest related --run packages/app/src/renderer/mentions.tsx`',
      '- [x] `pnpm smoke`',
      '- [ ] Try it with the tickets extension',
    ].join('\n'),
    comments: { totalCount: 57, nodes: [
      { author: { login: 'bo-lin' }, body: 'Love this. Does it work in a phone\'s composer too, or only on the desktop?', createdAt: at(3), url: `${URL(418)}#issuecomment-1` },
      { author: { login: 'mikker' }, body: '(Agent) It does: the phone composer uses the same `composer.mention` source, so the list shows above the keyboard.', createdAt: at(8), url: `${URL(418)}#issuecomment-2` },
    ] },
    reviews: { totalCount: 3, nodes: [
      { author: { login: 'bo-lin' }, state: 'COMMENTED', body: '', submittedAt: at(5), url: `${URL(418)}#pullrequestreview-1` },
      { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', body: 'Nice direction. Two things before it goes in: the search refetches too often, and `mention.search` needs a limit the caller sets. See the comments.', submittedAt: at(20), url: `${URL(418)}#pullrequestreview-2` },
    ] },
    latestReviews: { nodes: [{ author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: at(20) }, { author: { login: 'bo-lin' }, state: 'COMMENTED', submittedAt: at(5) }] },
    reviewThreads: { nodes: [
      comment('packages/app/src/renderer/mentions.tsx', 84, 'alice', "This refetches on every keystroke, even when the source's list is cached."),
      comment('packages/protocol/src/methods.ts', 212, 'alice', '`mention.search` wants a limit; 50 is baked in here.'),
      comment('CHANGELOG.md', 7, 'bo-lin', 'From the user\'s side: "Mention a ticket with @".'),
      { isResolved: true, path: 'README.md', line: 3, comments: { nodes: [{ author: { login: 'bo-lin' }, body: 'Typo', url: URL(418) }] } },
    ] },
  }, [run('test (ubuntu-latest)', 'FAILURE', 0, 281, 9101), run('smoke', 'FAILURE', 0, 475, 9103), ...passing]),
  'acme/ledger#421': pr(421, 'Code blocks: superego.codeBlock(languages, component)', {}, [run('test (ubuntu-latest)', null, 2, 0, 9201), run('smoke', null, 2, 0, 9203), run('lint', 'SUCCESS', 0, 38, 9205)]),
  'acme/ledger#420': pr(420, 'Terminal: resume programs that say how (OSC 7577)'),
  'acme/ledger#416': pr(416, 'Dialogs: ConfirmDialog and PromptDialog', {
    reviewDecision: 'CHANGES_REQUESTED', latestReviews: { nodes: [{ author: { login: 'bo-lin' }, state: 'CHANGES_REQUESTED', submittedAt: at(30) }] },
    reviewThreads: { nodes: [comment('packages/ui/src/dialog.tsx', 40, 'bo-lin', 'Enter should not confirm a danger dialog.'), comment('packages/ui/src/dialog.tsx', 88, 'bo-lin', 'Focus the field on open.')] },
  }),
  'acme/ledger#415': pr(415, 'Phone composer: one line level with + and send', { reviewDecision: 'APPROVED', latestReviews: { nodes: [{ author: { login: 'alice' }, state: 'APPROVED', submittedAt: at(40) }] } }),
  'acme/ledger#417': pr(417, 'UI playground: every @superego/ui component', { state: 'MERGED', reviewDecision: 'APPROVED' }),
  'acme/ledger#414': pr(414, 'Mermaid: ```mermaid blocks drawn by Pele', { isDraft: true, reviewDecision: null }, []),
  'acme/ledger#409': pr(409, "Phone: Commands from the drawer's foot", { state: 'CLOSED' }, []),
}
// #418 as it's first seen: checks running, not reviewed yet. Then (github.mjs swaps github-later.json in) two checks
// failed and alice asked for changes: told in the thread as notices.
writeFileSync(join(dir, 'github-later.json'), JSON.stringify({ login: 'mikker', prs }))
const first = { ...prs['acme/ledger#418'], reviewDecision: 'REVIEW_REQUIRED', latestReviews: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [run('test (ubuntu-latest)', null, 0, 0, 9101), run('smoke', null, 0, 0, 9103), ...passing] } } } }] } }
writeFileSync(join(dir, 'github.json'), JSON.stringify({ login: 'mikker', prs: { ...prs, 'acme/ledger#418': first } }))

// The thread that opens #418: pushes, runs `gh pr create` (its output stands in: the fake has no repository to push), says so.
const text = (t) => ({ type: 'text', text: t })
const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const turns = [
  { thread: OPENS, stopReason: 'toolUse', content: [call('push', 'bash', { command: "echo 'branch superego/mentions-ext set up to track origin/superego/mentions-ext' # git push -u origin superego/mentions-ext" })] },
  { thread: OPENS, stopReason: 'toolUse', content: [call('create', 'bash', { command: `echo ${URL(418)} # gh pr create --fill` })] },
  { thread: OPENS, stopReason: 'stop', content: [text(`Opened [#418](${URL(418)}): \`@<kind>:<id>\` mentions from \`composer.mention\`, drawn as links, with lists cached and searches debounced. CI is running; I'm not waiting on it.\n\nThe merged one it builds on is ${URL(417)}.`)] },
]
writeFileSync(turnsFile, turns.map(({ thread, ...message }) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', thread, message: { role: 'assistant', ...message } })).join('\n') + '\n')

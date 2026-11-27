// The turns test/schedules.mjs replays, before the app starts: `node schedules-setup.mjs <turns.jsonl>`. A thread that
// opens a PR and schedules a check of its CI every 30 minutes until green, and a reminder for the morning (notify: no
// turn when it fires); then its
// answers when the check fires (run now from the clock, and again late, after Superego wasn't running).
import { writeFileSync } from 'node:fs'

const [out] = process.argv.slice(2)
export const PROMPT = "Open the PR and check CI every 30 min until it's green."
let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `call-${++ids}`, name, arguments: args })
const text = (t) => ({ type: 'text', text: t })
const turn = (content) => ({ thread: PROMPT, content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' })
const turns = [
  turn([text("I'll open it, then keep an eye on CI."), call('schedule', {
    when: 'every 30m', label: 'Check CI', until: 'CI is green',
    message: 'Check CI on #212 (gh pr checks 212). Say which checks still run or fail.',
  })]),
  turn([text("Opened [#212](https://github.com/acme/ledger/pull/212). I'll look at CI every 30 minutes until it's green.")]),
  turn([call('schedule', { when: 'tomorrow 9:00', label: "Review Mia's PR", message: "Review Mia's PR (#209).", action: 'notify' })]),
  turn([text("I'll remind you at 09:00.")]),
  turn([text('3 of 5 checks pass. `test-linux` and `e2e` are still running; I\'ll look again in 30 minutes.')]),
  turn([text('4 of 5 checks pass now; `e2e` is still running.')]),
]
writeFileSync(out, turns.map((message) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', message: { role: 'assistant', ...message } })).join('\n') + '\n')

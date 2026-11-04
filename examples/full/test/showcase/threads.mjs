// Scripted threads for looking at the transcript: a small project, and the turns an agent takes on it. Tool calls run
// for real in the project (reads, a failing test, edits, one edit that misses), so results look like real ones.
// The replay provider serves the turns in order, so threads run one after another, in the order listed.

const text = (t) => ({ type: 'text', text: t })
const thinking = (t) => ({ type: 'thinking', thinking: t })
let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `call-${++ids}`, name, arguments: args })
const turn = (content, stopReason = content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop') => ({ content, stopReason })

export const files = {
  'package.json': `{
  "name": "ledger",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`,
  'src/dates.mjs': `// Parses the dates found in bank exports into UTC midnight.
export function parseDate(input) {
  const [day, month, year] = input.split('/').map(Number)
  return new Date(year, month - 1, day)
}
`,
  'test/dates.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDate } from '../src/dates.mjs'

test('day/month/year at UTC midnight', () => {
  assert.equal(parseDate('03/11/2026').toISOString(), '2026-11-03T00:00:00.000Z')
})

test('ISO dates pass through', () => {
  assert.equal(parseDate('2026-11-03').toISOString(), '2026-11-03T00:00:00.000Z')
})
`,
  'src/cli.mjs': `#!/usr/bin/env node
// ledger: import bank exports into the ledger.
import { readFileSync } from 'node:fs'
import { parseDate } from './dates.mjs'

const [command, file] = process.argv.slice(2)

if (command !== 'import' || !file) {
  console.error('usage: ledger import <file.csv>')
  process.exit(1)
}

const rows = readFileSync(file, 'utf8').trim().split('\\n').slice(1)
for (const row of rows) {
  const [date, description, amount] = row.split(',')
  save({ date: parseDate(date), description, amount: Number(amount) })
}
console.log(\`Imported \${rows.length} rows.\`)

function save(entry) {
  // Stands in for the database write.
  console.log('saved', entry.date.toISOString().slice(0, 10), entry.description, entry.amount)
}
`,
  'sample.csv': `date,description,amount
03/11/2026,Coffee at Rist,-4.50
04/11/2026,Salary November,3200
2026-11-05,Rent,-1450
`,
}

export const threads = [
  {
    prompt: 'Fix the date parsing in the importer. Rows from the Danske export land a day early, and ISO dates from the new bank come out as Invalid Date.',
    followUps: ['Good. Can it also reject impossible dates like 31/02/2026 instead of rolling them over into March?'],
  },
  {
    prompt: 'Add a --dry-run flag to the import command: show what would be saved, write nothing.',
    followUps: [],
  },
  {
    prompt: 'How should we structure retries for the bank sync? It hits three bank APIs that rate-limit and sometimes go down for an hour. Compare a few options before we pick one.',
    followUps: ['Go with the queue with backoff. Sketch it in src/retry.mjs, nothing fancy.'],
  },
]

export const turns = [
  // ── Thread 1: dates ─────────────────────────────────────────────────────────────────────────────────────────────
  turn([
    thinking('Two symptoms: a day early (timezone — local midnight converted to UTC lands on the previous day east of Greenwich… or west, depending) and ISO dates producing Invalid Date (the split on "/" gives one element). Read the parser and its tests first.'),
    text('Let me read the parser and its tests first.'),
    call('read', { path: 'src/dates.mjs' }),
    call('read', { path: 'test/dates.test.mjs' }),
  ]),
  turn([
    text('Both symptoms point at `parseDate`. Running the tests to see exactly how they fail:'),
    call('bash', { command: 'node --test 2>&1 | head -40' }),
  ]),
  turn([
    thinking('new Date(year, month - 1, day) builds local midnight. With TZ=America/New_York that is 05:00Z — not a day early there, but in any zone east of UTC it is the previous day in UTC. Either way it is wrong: the result must be UTC midnight, so Date.UTC. ISO: "2026-11-03".split("/") is one element, so month and year are undefined → NaN → Invalid Date. Match ISO explicitly.'),
    text(`Two separate bugs:

1. \`new Date(year, month - 1, day)\` builds midnight in the **local** timezone. Converted to UTC, that's the previous evening anywhere east of Greenwich, which is the "day early" you see.
2. An ISO date has no \`/\`, so the split yields one part and the rest is \`NaN\`.

Fixing both in one place:`),
    call('edit', {
      path: 'src/dates.mjs',
      edits: [{
        oldText: `export function parseDate(input) {
  const [day, month, year] = input.split('/').map(Number)
  return new Date(year, month - 1, day)
}`,
        newText: `export function parseDate(input) {
  const iso = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(input)
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  const [day, month, year] = input.split('/').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}`,
      }],
    }),
  ]),
  turn([
    call('bash', { command: 'node --test 2>&1 | head -8' }),
  ]),
  turn([
    text(`Fixed, and both tests pass.

**What changed in \`src/dates.mjs\`**

- Dates are built with \`Date.UTC\`, so \`03/11/2026\` is \`2026-11-03T00:00:00Z\` wherever the importer runs.
- \`YYYY-MM-DD\` is matched first and parsed the same way.

\`\`\`js
const iso = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(input)
if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
\`\`\`

Rows already imported from Danske are still a day off. If you want, I can write a one-off migration that shifts entries imported before today by one day, but that needs a look at how the ledger stores them first.`),
  ]),
  // Follow-up: impossible dates.
  turn([
    thinking('Date.UTC(2026, 1, 31) rolls to March 3rd. Check the components round-trip; throw a RangeError otherwise. Same for the ISO path, so put the check after building the date in both branches — simplest is a small helper.'),
    text('`Date.UTC` silently rolls `31/02` over to 3 March. I\'ll check that the parts survive the round trip, for both formats:'),
    call('edit', {
      path: 'src/dates.mjs',
      edits: [{
        oldText: `  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
  const [day, month, year] = input.split('/').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}`,
        newText: `  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]), input)
  const [day, month, year] = input.split('/').map(Number)
  return utc(year, month, day, input)
}

/** UTC midnight on that day, or a RangeError for a day that doesn't exist (31/02 doesn't roll over into March). */
function utc(year, month, day, input) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(\`Not a date: \${input}\`)
  }
  return date
}`,
      }],
    }),
    call('edit', {
      path: 'test/dates.test.mjs',
      edits: [{
        oldText: `test('ISO dates pass through', () => {
  assert.equal(parseDate('2026-11-03').toISOString(), '2026-11-03T00:00:00.000Z')
})`,
        newText: `test('ISO dates pass through', () => {
  assert.equal(parseDate('2026-11-03').toISOString(), '2026-11-03T00:00:00.000Z')
})

test('impossible dates are refused', () => {
  assert.throws(() => parseDate('31/02/2026'), /Not a date: 31\\/02\\/2026/)
  assert.throws(() => parseDate('2026-13-01'), RangeError)
})`,
      }],
    }),
  ]),
  turn([
    call('bash', { command: 'node --test 2>&1 | head -8' }),
  ]),
  turn([
    text(`Done. \`parseDate('31/02/2026')\` now throws \`RangeError: Not a date: 31/02/2026\`, and so does a month 13 in ISO form. All three tests pass.

The importer doesn't catch that error yet, so one bad row stops the whole import. Skipping and reporting bad rows would be the friendlier default. Say the word and I'll add it.`),
  ]),

  // ── Thread 2: --dry-run ─────────────────────────────────────────────────────────────────────────────────────────
  turn([
    text('I\'ll look at how the import command reads its arguments.'),
    call('read', { path: 'src/cli.mjs' }),
    call('bash', { command: 'ls && head -3 sample.csv' }),
  ]),
  turn([
    thinking('Arguments are positional only. Plan: pull flags out before destructuring, guard save() behind dryRun, change the closing line, update usage. Edit in one call.'),
    text('Arguments are read positionally, so a flag would land in `file`. I\'ll separate flags first, then guard the write:'),
    call('edit', {
      path: 'src/cli.mjs',
      edits: [{ oldText: 'const [command, file] = process.argv.slice(2);\n', newText: 'const args = process.argv.slice(2)\n' }],
    }),
  ]),
  turn([
    text('No semicolons in this file. Retrying with the exact lines, all three changes at once:'),
    call('edit', {
      path: 'src/cli.mjs',
      edits: [
        {
          oldText: 'const [command, file] = process.argv.slice(2)\n',
          newText: "const args = process.argv.slice(2)\nconst dryRun = args.includes('--dry-run')\nconst [command, file] = args.filter((arg) => !arg.startsWith('--'))\n",
        },
        { oldText: "  console.error('usage: ledger import <file.csv>')", newText: "  console.error('usage: ledger import <file.csv> [--dry-run]')" },
        {
          oldText: '  save({ date: parseDate(date), description, amount: Number(amount) })\n}\nconsole.log(`Imported ${rows.length} rows.`)',
          newText: "  const entry = { date: parseDate(date), description, amount: Number(amount) }\n  if (dryRun) console.log('would save', entry.date.toISOString().slice(0, 10), description, entry.amount)\n  else save(entry)\n}\nconsole.log(dryRun ? `Dry run: ${rows.length} rows, nothing saved.` : `Imported ${rows.length} rows.`)",
        },
      ],
    }),
  ]),
  turn([
    call('bash', { command: 'node src/cli.mjs import sample.csv --dry-run' }),
    call('bash', { command: 'node src/cli.mjs import --dry-run; echo "exit $?"' }),
  ]),
  turn([
    text(`\`--dry-run\` works:

\`\`\`
$ ledger import sample.csv --dry-run
would save 2026-11-03 Coffee at Rist -4.5
would save 2026-11-04 Salary November 3200
would save 2026-11-05 Rent -1450
Dry run: 3 rows, nothing saved.
\`\`\`

- Flags can go anywhere; anything starting with \`--\` is taken out before the command and file are read.
- The usage line mentions the flag, and a missing file still exits with 1.
- Nothing else changed: without the flag, rows are saved as before.`),
  ]),

  // ── Thread 3: retries ───────────────────────────────────────────────────────────────────────────────────────────
  turn([
    thinking('Three APIs, rate limits (429 with Retry-After usually), hour-long outages. Options: inline retry with backoff; a persistent job queue with backoff and per-bank circuit; scheduled reconciliation (just sync again later from a cursor). Compare on outage handling, duplicates, complexity.'),
    text(`Three shapes are worth comparing. They differ mostly in **where a failed sync waits**: in memory, in a queue, or nowhere at all.

## 1. Retry inline with backoff

Each sync call retries itself: wait 1s, 2s, 4s… up to a cap, honouring \`Retry-After\` on a 429.

- Good for rate limits and short blips.
- An hour-long outage means a process sitting in a loop for an hour, and a restart forgets everything.

## 2. A queue with backoff

A failed sync becomes a job with a \`runAt\` in the future. A worker picks up due jobs; each failure pushes \`runAt\` out further. A bank that keeps failing gets a **circuit**: its jobs pause until a probe succeeds.

- Survives restarts and long outages; one down bank doesn't hold up the others.
- Needs a table and a worker, and jobs must be idempotent, because a job can run twice.

## 3. Reconcile on a schedule

Don't retry at all. Every 15 minutes, sync each bank from its last good cursor. A failure just means the next run picks up more.

- The simplest to operate, and duplicates are impossible if the cursor is right.
- Latency is up to one interval even when nothing is wrong, and you can't tell "down" from "quiet" without extra bookkeeping.

## Side by side

| | Inline | Queue | Scheduled |
|---|---|---|---|
| Rate limits | good | good | fine |
| Hour-long outage | poor | good | good |
| Survives restart | no | yes | yes |
| Moving parts | none | table + worker | cron |
| Duplicate risk | low | needs idempotency | none |

> If the banks give you a reliable cursor, **3** is hard to beat. If they don't (two of the three APIs you described page by date, not cursor), **2** is the safe choice, with inline backoff *inside* each job for 429s.

I'd go with the queue, and keep each job small: one bank, one account, one page.`),
  ]),
  turn([
    text('Here\'s a sketch, kept in memory so it runs as is. The store is one object to swap for a table later.'),
    call('write', {
      path: 'src/retry.mjs',
      content: `// Retries for the bank sync: failed jobs wait with exponential backoff, and a bank that keeps failing is paused
// (a circuit) until a probe gets through. In memory for now; \`store\` is the seam for a real table.

const BASE = 1_000
const CAP = 30 * 60_000
const TRIP_AFTER = 5

export function createQueue({ run, now = Date.now, store = new Map() }) {
  const circuits = new Map() // bank → { failures, openUntil }

  function add(job) {
    store.set(job.id, { ...job, attempts: 0, runAt: now() })
  }

  /** Run every job that is due, unless its bank's circuit is open. */
  async function tick() {
    for (const job of [...store.values()].filter((j) => j.runAt <= now())) {
      const circuit = circuits.get(job.bank)
      if (circuit && circuit.openUntil > now()) continue
      try {
        await run(job)
        store.delete(job.id)
        circuits.delete(job.bank)
      } catch (error) {
        job.attempts++
        job.runAt = now() + backoff(job.attempts, error.retryAfter)
        trip(job.bank)
      }
    }
  }

  function trip(bank) {
    const circuit = circuits.get(bank) ?? { failures: 0, openUntil: 0 }
    circuit.failures++
    if (circuit.failures >= TRIP_AFTER) circuit.openUntil = now() + CAP
    circuits.set(bank, circuit)
  }

  return { add, tick, pending: () => store.size }
}

/** 1s, 2s, 4s … up to 30 minutes, with jitter; a server's Retry-After wins. */
export function backoff(attempts, retryAfter) {
  if (retryAfter) return retryAfter * 1_000
  const ms = Math.min(CAP, BASE * 2 ** (attempts - 1))
  return ms / 2 + Math.random() * (ms / 2)
}
`,
    }),
  ]),
  turn([
    call('bash', { command: `node -e "import('./src/retry.mjs').then(({ backoff }) => console.log([1, 2, 3, 10, 20].map((n) => Math.round(backoff(n) / 1000) + 's').join(' ')))"` }),
  ]),
  turn([
    text(`\`src/retry.mjs\` is in place: about 50 lines, no dependencies.

- **\`createQueue({ run })\`** takes the function that syncs one job. \`add(job)\` queues it, and \`tick()\` runs whatever is due. Call \`tick\` from a timer.
- **Backoff** doubles from 1s up to 30 minutes, with jitter so the three banks don't retry in lockstep. A \`retryAfter\` on the error wins.
- **The circuit** opens after five failures in a row for one bank and pauses only that bank's jobs for 30 minutes.

Before this goes near production:

1. Swap \`store\` for a table, so jobs survive a restart.
2. Make \`run\` idempotent per page. A job can run twice if the process dies between the sync and \`store.delete\`.
3. Log circuit changes. "Danske paused until 14:30" is what you'll want to see during an outage.`),
  ]),
]

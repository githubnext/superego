// The scripted model's turns for test/profile.mjs, and the project they work in. The replay provider serves the turns
// in order, one per request, so the profile sends to its threads one at a time in the order below (`PLAN`); a thread
// left working (a long `sleep`, a loop printing) never asks for another.
import { deflateSync, crc32 } from 'node:zlib'

const text = (t) => ({ type: 'text', text: t })
const thinking = (t) => ({ type: 'thinking', thinking: t })
let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `call-${++ids}`, name, arguments: args })
const turn = (content) => ({ content, stopReason: content.some((b) => b.type === 'toolCall') ? 'toolUse' : 'stop' })

/** How many of each, in the order the profile asks for their turns. */
export const PLAN = {
  /**
   * The long transcript: this many messages, each answered after `longTurns` turns of `longCalls` tool calls (12 × 5 ×
   * 30: 1,800 calls).
   */
  longMessages: Number(process.env.PROFILE_LONG_MESSAGES || 12),
  longTurns: 5,
  longCalls: 30,
  /** Threads that answered once. */
  done: 6,
  /** Threads working on a long `sleep`: working, saying nothing. */
  sleepers: 4,
  /** Threads working on a loop that prints a line every half second. */
  printers: 3,
  /** Each streaming run: this many turns of long Markdown and a few tool calls, then an answer. Three runs: two in the
   * streaming scenario, one into the long transcript. */
  streamTurns: 6,
  /** Pairs of turns (a tool call, then an answer) for the memory scenario's runs. */
  memoryRuns: 400,
}

/** A PNG of `width`×`height`, a gradient in `hue`. */
export function png(width, height, hue) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 255 / width + hue) & 255
      raw[row + 2 + x * 3] = (y * 255 / height) & 255
      raw[row + 3 + x * 3] = (hue * 3) & 255
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const SOURCE = (n) => `// Module ${n}: parses one kind of row from the bank exports.
export function parse${n}(row) {
  const [date, description, amount] = row.split(',')
  if (!date || !description) throw new Error(\`Row ${n} is missing a field: \${row}\`)
  return { date: new Date(date), description: description.trim(), amount: Number(amount) }
}

export function total${n}(rows) {
  return rows.map(parse${n}).reduce((sum, row) => sum + row.amount, 0)
}
`

export const files = {
  'README.md': `# Ledger\n\nReads the CSV exports from the bank and totals them by month.\n\n| Month | Spent |\n| --- | ---: |\n| January | 1,204.50 |\n`,
  'page.html': `<!doctype html><title>Report</title><style>body{font:14px system-ui;margin:2em}</style><h1>Monthly report</h1>${'<p>Spent 1,204.50 in January, mostly on rent and groceries.</p>'.repeat(40)}`,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`src/module${n}.mjs`, SOURCE(n)])),
}
/** Binary files: the images the long transcript reads. */
export const images = { 'shots/one.png': png(800, 500, 10), 'shots/two.png': png(640, 640, 90), 'shots/three.png': png(1200, 700, 170) }

const PARAGRAPH = 'The importer reads each row, parses its date and amount, and saves it; rows that fail are skipped with a warning, which hides real problems in the exports. '
const CODE = (n) => `\`\`\`ts
export async function sync${n}(bank: Bank, since: Date): Promise<SyncResult> {
  const rows = await bank.export({ since, format: 'csv' })
  const parsed = rows.map((row, i) => parseRow(row, i)).filter((r): r is Row => r !== undefined)
  for (const batch of chunks(parsed, 100)) await db.insert('ledger', batch)
  return { imported: parsed.length, skipped: rows.length - parsed.length }
}
\`\`\``

/** A long Markdown answer: headings, lists, a table, code. */
const longMarkdown = (n) => `## Step ${n}: what the sync does now

${PARAGRAPH.repeat(3)}

- **Retries:** each bank is retried with backoff, up to \`maxAttempts\` (5 by default).
- **Rate limits:** a 429 waits for \`Retry-After\` before the next attempt.
- **Outages:** after an hour of failures the bank is marked down, and the next sync tries again.

${CODE(n)}

| Bank | Rows | Skipped | Time |
| --- | ---: | ---: | ---: |
| Danske | 1,204 | 3 | 1.2 s |
| Nordea | 987 | 0 | 0.8 s |
| Lunar | 312 | 12 | 0.4 s |

${PARAGRAPH.repeat(2)}

\`\`\`python
def backoff(attempt: int, base: float = 0.5, cap: float = 30.0) -> float:
    """Seconds to wait before the next attempt: exponential, with jitter, capped."""
    return min(cap, base * 2 ** attempt) * (0.5 + random.random() / 2)
\`\`\`

1. Read the export.
2. Parse every row, keeping the ones that fail with their reason.
3. Save in batches of a hundred.

> Rows that fail are kept with their reason now, so a bad export shows up in the report instead of vanishing.

${PARAGRAPH.repeat(2)}`

/**
 * The long transcript: tool calls in their thousands (outputs, reads, images, edits), a little text between; kept short
 * enough that the thread never compacts (which would ask the model, taking a turn out of order).
 */
function longTurns() {
  const out = []
  for (let i = 0; i < PLAN.longMessages * PLAN.longTurns; i++) {
    const calls = []
    for (let c = 0; c < PLAN.longCalls; c++) {
      const k = i * PLAN.longCalls + c
      if (c === 0) calls.push(call('write', { path: `notes/n${i}.md`, content: `# Note ${i}\n\nfirst\nsecond\nthird\n` }))
      else if (c === 1 && i > 0) calls.push(call('edit', { path: `notes/n${i - 1}.md`, edits: [{ oldText: 'second', newText: `second, edited in ${i}` }] }))
      else if (c === 2 && i % 10 === 0) calls.push(call('read', { path: ['shots/one.png', 'shots/two.png', 'shots/three.png'][(i / 10) % 3] }))
      else if (c === 3) calls.push(call('read', { path: `src/module${k % 12}.mjs` }))
      else if (c === 4) calls.push(call('bash', { command: `seq 1 8` }))
      else calls.push(call('bash', { command: `echo ok ${k}` }))
    }
    out.push(turn([
      ...(i % 10 === 0 ? [thinking(`Turn ${i}: the next batch of modules.`)] : []),
      text(i % 10 === 0 ? `Batch ${i}.\n\n${CODE(i)}` : `Batch ${i}.`),
      ...calls,
    ]))
    if (i % PLAN.longTurns === PLAN.longTurns - 1) out.push(turn([text(`## Batches up to ${i} audited\n\n${PARAGRAPH.repeat(2)}\n\n${CODE(i)}`)]))
  }
  return out
}

function streamTurns(run) {
  const out = []
  for (let i = 0; i < PLAN.streamTurns; i++) {
    out.push(turn([
      thinking(`Run ${run}, part ${i}. ${PARAGRAPH}`),
      text(longMarkdown(i)),
      call('read', { path: `src/module${i}.mjs` }),
      call('bash', { command: `seq 1 40 | sed 's/^/synced row /'` }),
      call('edit', { path: `src/module${i}.mjs`, edits: [{ oldText: `parse${i}(row) {`, newText: `parse${i}(row /* run ${run} */) {` }] }),
    ]))
  }
  out.push(turn([text(longMarkdown(99))]))
  return out
}

/** Every turn, in the order the profile asks for them. */
export function turns() {
  return [
    ...longTurns(),
    ...Array.from({ length: PLAN.done }, (_, i) => turn([text(`Done: batch ${i} imported. ${PARAGRAPH}\n\n${CODE(i)}`)])),
    ...Array.from({ length: PLAN.sleepers }, () => turn([text('Waiting for the export to finish.'), call('bash', { command: 'sleep 7200' })])),
    ...Array.from({ length: PLAN.printers }, (_, i) => turn([text('Watching the sync.'), call('bash', { command: `for i in $(seq 1 100000); do echo "worker ${i}: synced batch $i"; sleep 0.5; done` })])),
    ...streamTurns(1),
    ...streamTurns(2),
    ...streamTurns(3),
    ...Array.from({ length: PLAN.memoryRuns }, (_, i) => [
      turn([text(`Looking at module ${i % 12}.`), call('read', { path: `src/module${i % 12}.mjs` }), call('bash', { command: `ls src | head -${1 + (i % 12)}` })]),
      turn([text(longMarkdown(i).slice(0, 1600))]),
    ]).flat(),
  ]
}

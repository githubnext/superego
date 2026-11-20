// The turns test/themes.mjs replays, before the app starts: `node themes-setup.mjs <turns.jsonl>`. One answer with code
// and a diff in it, for the themes to colour.
import { writeFileSync } from 'node:fs'

const [out] = process.argv.slice(2)
const answer = `Parse the date as UTC, so it lands on the day it says:

\`\`\`ts
// Dates in bank exports, at UTC midnight.
export function parseDate(input: string): Date {
  const [day, month, year] = input.split('/').map(Number)
  if (!year) return new Date(\`\${input}T00:00:00Z\`)
  return new Date(Date.UTC(year, month - 1, day)) // 0-based months
}
\`\`\`

The change:

\`\`\`diff
-  return new Date(year, month - 1, day)
+  return new Date(Date.UTC(year, month - 1, day))
\`\`\`
`
const turns = [{ content: [{ type: 'text', text: answer }], stopReason: 'stop' }]
writeFileSync(out, turns.map((message) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', message: { role: 'assistant', ...message } })).join('\n') + '\n')

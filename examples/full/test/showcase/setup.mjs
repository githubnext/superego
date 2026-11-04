// Writes the showcase project and the replay file: `node setup.mjs <project dir> <turns.jsonl>`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { files, turns } from './threads.mjs'

const [project, out] = process.argv.slice(2)
for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), content)
}
writeFileSync(out, turns.map((message) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', message: { role: 'assistant', ...message } })).join('\n') + '\n')

// Writes the profile's project and the replay file: `node setup.mjs <project dir> <turns.jsonl>`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { files, images, turns } from './turns.mjs'

const [project, out] = process.argv.slice(2)
for (const [path, content] of Object.entries({ ...files, ...images })) {
  mkdirSync(dirname(join(project, path)), { recursive: true })
  writeFileSync(join(project, path), content)
}
mkdirSync(join(project, 'notes'), { recursive: true })
writeFileSync(out, turns().map((message) => JSON.stringify({ at: 0, provider: 'profile', model: 'profile', message: { role: 'assistant', ...message } })).join('\n') + '\n')

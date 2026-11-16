// The app's machine id is spelled once, as `APP` (shared/app-settings.ts): the renderer never writes it out. An
// action's `runs: 'app'` is another thing (where it runs, `Runs`), and may.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '../src/renderer')

it("doesn't spell the app's machine id in the renderer", () => {
  const found: string[] = []
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file)) continue
    readFileSync(join(root, file), 'utf8').split('\n').forEach((line, i) => {
      if (/(['"`])app\1/.test(line.replace(/runs: 'app'/g, ''))) found.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(found).toEqual([])
})

// The guide's build queue (docs/examples), data-only and with a UI half, as an outside author would have it: copied
// into a profile of their own, type-checked against the stable surface, and its own tests run by `superego extension
// test`'s path.
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { sdkPaths, testExtension } from '../src/extensions.ts'
import { tsconfig } from '../src/starter.ts'

const examples = fileURLToPath(new URL('../../../docs/examples/', import.meta.url))
let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-examples-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

for (const example of ['build-queue', 'build-queue-ui']) {
  it(`builds ${example} from the docs: its types check, and its tests pass`, async () => {
    const profile = join(dir, example)
    await cp(join(examples, example), profile, { recursive: true })
    const { sdkDir, repoDir } = sdkPaths()
    await writeFile(join(profile, 'tsconfig.json'), tsconfig(sdkDir, repoDir))
    expect(await testExtension(profile)).toBe(0)
  }, 240_000)
}

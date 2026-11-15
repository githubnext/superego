// The guide's build queue (docs/examples), data-only and with a UI half, as an outside author would have it: copied
// into a profile of their own, type-checked against the author types (what `superego profile types` links), and its
// own tests run by `superego extension test`'s path.
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { setUpProfileTypes } from '@superego/client/author-types'
import { authorTypes, testExtension } from '../src/extensions.ts'

const examples = fileURLToPath(new URL('../../../docs/examples/', import.meta.url))
let dir: string
let types: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'superego-examples-'))
  types = await authorTypes(join(dir, 'data'))
}, 240_000)
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

for (const example of ['build-queue', 'build-queue-ui']) {
  it(`builds ${example} from the docs: its types check, and its tests pass`, async () => {
    const profile = join(dir, example)
    await cp(join(examples, example), profile, { recursive: true })
    setUpProfileTypes(profile, types)
    expect(await testExtension(profile, undefined, types)).toBe(0)
  }, 240_000)
}

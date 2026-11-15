// The author types the tests share, installed once a run where vitest.config.ts says. Installing them is a copy of some
// 2,000 files, and removing them as many deletions: seconds each on a busy machine, which ran each test file that did
// its own past its hooks' and tests' limits. profile-types.test.ts alone installs its own, as `superego profile new`
// does. Nothing writes to these.
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { authorTypes } from '../src/extensions.ts'

/** The shared author types (`authorTypes`'s folder), made current once a run. */
export function sharedAuthorTypes(): Promise<string> {
  const dataDir = process.env.SUPEREGO_TEST_AUTHOR_TYPES
  if (!dataDir) throw new Error('No SUPEREGO_TEST_AUTHOR_TYPES: run the tests with the repo\'s vitest.config.ts')
  return authorTypes(dataDir)
}

/** `dataDir`'s author types, as a command line finds them installed there: a link to the shared ones. */
export async function linkAuthorTypes(dataDir: string) {
  mkdirSync(dataDir, { recursive: true })
  symlinkSync(await sharedAuthorTypes(), join(dataDir, 'types'))
}

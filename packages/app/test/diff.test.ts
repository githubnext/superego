// The kit's diff: a unified diff read into files with their counts, and its lines numbered as the files have them.
import { expect, it } from 'vitest'
import { numbered, parseDiff } from '../src/renderer/diff.tsx'

const diff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -3,3 +3,4 @@ start',
  ' kept',
  '-gone',
  '+new',
  '+also new',
  ' kept too',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1 @@',
  '+hello',
  '\\ No newline at end of file',
].join('\n')

it('reads a unified diff into files, each with what it adds and removes, without the headers', () => {
  const files = parseDiff(diff)
  expect(files.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([
    { path: 'src/app.ts', added: 2, removed: 1 },
    { path: 'docs/new.md', added: 1, removed: 0 },
  ])
  expect(files[0]!.lines[0]).toBe('@@ -3,3 +3,4 @@ start')
  expect(files[1]!.lines).toEqual(['@@ -0,0 +1 @@', '+hello', '\\ No newline at end of file'])
  expect(parseDiff('')).toEqual([])
})

it("numbers each line as the new file has it, a removed one as the old file had it, and hunks and notes not at all", () => {
  expect(numbered(parseDiff(diff)[0]!.lines).map((l) => l.number)).toEqual([undefined, 3, 4, 4, 5, 6])
  expect(numbered(parseDiff(diff)[1]!.lines).map((l) => l.number)).toEqual([undefined, 1, undefined])
})

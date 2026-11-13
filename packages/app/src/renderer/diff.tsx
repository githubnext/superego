// A unified diff (git's), drawn file by file: each file's path and its +N −N, folded open, its lines numbered as in the
// new file (a removed line, as in the old one). A kit component, for any pane that shows changes; `parseDiff` reads
// the same text into files, for counting.
import { CaretDownIcon } from '@superego/ui'

/** One file's part of a diff: its path, how many lines it adds and removes, and its lines from the first hunk on. */
export type DiffFile = { path: string; added: number; removed: number; lines: string[] }

/** The files of a unified diff (`git diff`), in order. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), added: 0, removed: 0, lines: [] }
      files.push(file)
    } else if (!file || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue
    else {
      file.lines.push(line)
      if (line.startsWith('+')) file.added++
      else if (line.startsWith('-')) file.removed++
    }
  }
  return files
}

/** A file's diff lines, each with its line number: the new file's, or the old one's for a removed line. */
export function numbered(lines: string[]) {
  let old = 0
  let now = 0
  return lines.map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) { old = Number(hunk[1]); now = Number(hunk[2]); return { line, number: undefined } }
    if (line.startsWith('-')) return { line, number: old++ }
    if (line.startsWith('+')) return { line, number: now++ }
    if (line.startsWith('\\')) return { line, number: undefined }
    old++
    return { line, number: now++ }
  })
}

/** A diff's files, given as its text or already parsed. */
export function Diff({ diff }: { diff: string | DiffFile[] }) {
  const files = typeof diff === 'string' ? parseDiff(diff) : diff
  return <>{files.map((file) => {
    const slash = file.path.lastIndexOf('/') + 1
    return (
      <details key={file.path} className="diff-file" open>
        <summary>
          <CaretDownIcon className="diff-file__caret" size={11} weight="bold" aria-hidden />
          <span className="diff-file__path" title={file.path}><span className="diff-file__dir">{file.path.slice(0, slash)}</span>{file.path.slice(slash)}</span>
          <span className="diff-file__stat"><span className="stat--add">+{file.added}</span> <span className="stat--del">−{file.removed}</span></span>
        </summary>
        <pre className="diff-file__body">{numbered(file.lines).map(({ line, number }, i) => (
          <span key={i} className={`diff-row diff-row--${line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx'}`}>
            {!line.startsWith('@@') && <span className="diff-row__num">{number ?? ''}</span>}{line || ' '}
          </span>
        ))}</pre>
      </details>
    )
  })}</>
}

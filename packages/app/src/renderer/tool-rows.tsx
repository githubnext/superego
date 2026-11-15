// Tool calls in the transcript, as rows: an icon, a verb, what the call acted on, and what it opens to. Tools describe
// their rows (`superego.tool(name, row)`, a `ToolRow`); the core draws them, and says what a run of them did in a line.
// The core is the first to describe its own: the coding tools (read, bash, edit, write).
import { useState, type ReactNode } from 'react'
import { CaretRightIcon, FilePlusIcon, FileTextIcon, PencilSimpleIcon, SparkleIcon, StatusGlyph, TerminalIcon, WrenchIcon } from '@superego/ui'
import type { ToolRow, ToolRowCall, UiApi, WorkBlock } from './extension.tsx'
import { Scroll } from './Markdown.tsx'

/** The coding tools' rows. */
export function registerToolRows(core: UiApi) {
  const path = (args: Record<string, unknown>) => typeof args.path === 'string' ? args.path : undefined
  core.tool('read', { icon: FileTextIcon, verbs: ['Read', 'Reading', 'Read failed'], phrase: (k) => `read ${n(k, 'a file', 'files')}`, file: path, weight: 1 })
  core.tool('bash', { icon: TerminalIcon, verbs: ['Ran', 'Running', 'Command failed'], phrase: (k) => `ran ${n(k, 'a command', 'commands')}`, weight: 2 })
  core.tool('edit', { icon: PencilSimpleIcon, verbs: ['Edited', 'Editing', 'Edit failed'], phrase: (k) => `edited ${n(k, 'a file', 'files')}`, file: path, weight: 4 })
  const written = ({ call }: ToolRowCall) => typeof call.arguments.content === 'string' ? call.arguments.content : undefined
  core.tool('write', {
    icon: FilePlusIcon, verbs: ['Wrote', 'Writing', 'Write failed'], phrase: (k) => `wrote ${n(k, 'a file', 'files')}`, file: path, weight: 3,
    meta: (c) => { const text = written(c); return text === undefined ? undefined : `${lineCount(text)} lines` },
    body: (c) => { const text = written(c); return text === undefined ? undefined : <Output text={text} /> },
  })
}

const n = (k: number, one: string, many: string) => k === 1 ? one : `${k} ${many}`

/** A call drawn from its tool's row: the row folds open to its body. */
export function DescribedCall({ row, call }: { row: ToolRow; call: ToolRowCall }) {
  const { state } = call
  const name = call.call.name
  const verb = row.verb?.(call) ?? (row.verbs ? row.verbs[state === 'error' ? 2 : state === 'working' ? 1 : 0] : state === 'error' ? `${name} failed` : name)
  const said = row.subject?.(call)
  const subject = said === undefined ? summaryOf(name, call.call.arguments) : said
  const stat = statOf(row, call)
  const meta = row.meta?.(call)
  const body = row.body?.(call)
  return (
    <details className={`step step--${state}`}>
      <summary className="row">
        <Chevron />
        {state === 'working' ? <StatusGlyph status={{ state }} /> : <RowIcon row={row} />}
        <span className="row__label">{verb}</span>
        {typeof subject === 'string' ? <span className="row__arg" title={subject}>{subject}</span> : subject}
        {stat && <span className="row__meta"><Stat {...stat} /></span>}
        {meta !== undefined && meta !== null && <span className="row__meta">{meta}</span>}
      </summary>
      {body !== undefined ? body : <DefaultBody call={call} />}
    </details>
  )
}

/** What a call opens to by default: the diff it reported, else its output (or its error). */
function DefaultBody({ call: { state, result, live } }: { call: ToolRowCall }) {
  const diff = state !== 'error' ? diffOf(result?.details) : undefined
  if (diff) return <StepDiff diff={diff} />
  const output = result ? unwrap(result.text) : live?.output
  return output ? <Output text={output} className={state === 'error' ? 'is-error' : ''} /> : null
}

/** A row's lines added and removed: as it says, else the diff its result reported. */
export function statOf(row: ToolRow, call: ToolRowCall) {
  const stat = row.stat?.(call)
  if (stat !== undefined) return stat
  const diff = call.state !== 'error' ? diffOf(call.result?.details) : undefined
  return diff ? diffStat(diff) : undefined
}

export const Chevron = () => <CaretRightIcon className="row__chevron" size={12} aria-hidden />

/** A small, static glyph per kind of row: the tool's own, a wrench when it has none; thinking's sparkle. */
export function RowIcon({ row, thinking }: { row?: ToolRow; thinking?: boolean }) {
  const Glyph = thinking ? SparkleIcon : row?.icon ?? WrenchIcon
  return <Glyph className="row__icon" size={14} aria-hidden />
}

/** What a run mostly did, by weight: an edit matters more than a command, a command more than a read; else its first tool. */
export function mainKind(blocks: WorkBlock[], rowOf: (name: string) => ToolRow): string {
  const names = blocks.filter((b) => b.type === 'toolCall').map((b) => b.name ?? '')
  let main = names[0]
  for (const name of names) if ((rowOf(name).weight ?? 0) > (rowOf(main!).weight ?? 0)) main = name
  return main ?? 'thinking'
}

/** "Read 2 files, ran 3 commands and edited a file", as text and paths in turn: ['Edited ', 'src/a.ts', ' and ran a command']. */
export function describeRun(blocks: WorkBlock[], rowOf: (name: string) => ToolRow): string[] {
  const count = new Map<string, number>()
  // Tools that share a row that phrases them (a prefix's: every `mcp__` tool) are one kind, named by the first of them.
  const firsts = new Map<ToolRow, string>()
  const kindOf = (name: string) => {
    const row = rowOf(name)
    if (!row.phrase) return name
    if (!firsts.has(row)) firsts.set(row, name)
    return firsts.get(row)!
  }
  // Thinking between steps is part of the work; it's named only when that's all there is.
  const tools = blocks.filter((b) => b.type === 'toolCall')
  for (const b of tools.length ? tools : blocks.filter((b) => b.type === 'thinking')) { const kind = b.type === 'thinking' ? 'thinking' : kindOf(b.name ?? 'tool'); count.set(kind, (count.get(kind) ?? 0) + 1) }
  // The weightiest kind leads, naming its file when it was one call about one.
  const main = kindOf(mainKind(blocks, rowOf))
  const mainRow = rowOf(main)
  const files = tools.filter((b) => kindOf(b.name ?? 'tool') === main).map((b) => mainRow.file?.((b.arguments ?? {}) as Record<string, unknown>))
  const only = files.length === 1 && typeof files[0] === 'string' ? files[0] : undefined
  const ordered = [...count].sort((a, b) => (a[0] === main ? -1 : b[0] === main ? 1 : 0))
  const phrases = ordered.map(([kind, k]) => {
    if (kind === main && only) return `${mainRow.verbs?.[0].toLowerCase() ?? kind} \u0000${only}\u0000`
    if (kind === 'thinking') return 'thought'
    return rowOf(kind).phrase?.(k) ?? `used ${kind}${k > 1 ? ` ${k}×` : ''}`
  })
  const text = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}` : phrases[0] ?? ''
  return (text.charAt(0).toUpperCase() + text.slice(1)).split('\u0000')
}

/** Tool output, up to a dozen whole lines; the rest behind "Show all". */
export function Output({ text, className = '' }: { text: string; className?: string }) {
  const [all, setAll] = useState(false)
  const lines = text.replace(/\n+$/, '').split('\n')
  const long = lines.length > CAP + 3
  return (
    <div className={`step__output ${long && !all ? 'is-cut' : ''} ${className}`}>
      <Scroll>{long && !all ? lines.slice(0, CAP).join('\n') : lines.join('\n')}</Scroll>
      {long && <button type="button" className="step__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  )
}
const CAP = 12

export const Stat = ({ added, removed }: { added: number; removed: number }) => (
  <>{added > 0 && <span className="stat--add">+{added}</span>}{added > 0 && removed > 0 && ' '}{removed > 0 && <span className="stat--del">−{removed}</span>}</>
)

/** A tool's error as the harness wraps it (`<harness>[error] …</harness>`), as just the message. */
export const unwrap = (text: string) => text.replace(/^\s*<harness>\s*(?:\[error\]\s*)?([\s\S]*?)\s*<\/harness>\s*$/, '$1')

/** What a call is about, in a line: the command, the path, else its arguments. */
function summaryOf(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command
  if (typeof args.path === 'string') return args.path
  if (typeof args.pattern === 'string') return args.pattern
  return name ? JSON.stringify(args) : ''
}

const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length
const diffOf = (details: unknown) => typeof (details as { diff?: unknown } | undefined)?.diff === 'string' ? (details as { diff: string }).diff : undefined
function diffStat(diff: string) {
  const lines = diff.split('\n')
  return { added: lines.filter((l) => l.startsWith('+')).length, removed: lines.filter((l) => l.startsWith('-')).length }
}

/** An edit's diff, as the edit tool reports it: `+12 added`, `-12 removed`, ` 12 context`, and `...` between hunks. */
export function StepDiff({ diff }: { diff: string }): ReactNode {
  // The tool numbers context and removed lines by the old file, added lines by the new one. Both columns show:
  // the old number (context, removed) and the new one (context shifted by what changed above it, added).
  const [all, setAll] = useState(false)
  let shift = 0
  const lines = diff.split('\n').map((line) => {
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : /^\s*\.\.\.\s*$/.test(line) ? 'gap' : 'ctx'
    const match = /^[+\- ](\s*\d+) (.*)$/.exec(line)
    const n = match ? Number(match[1]) : undefined
    const old = n === undefined || kind === 'add' ? '' : String(n)
    const next = n === undefined || kind === 'del' ? '' : kind === 'add' ? String(n) : String(n + shift)
    if (kind === 'add') shift++
    if (kind === 'del') shift--
    return { kind, old, next, text: match ? match[2]! : kind === 'gap' ? '⋯' : line }
  })
  const long = lines.length > CAP * 2
  return (
    <div className="step__output step__diff">
      <Scroll>
        {(long && !all ? lines.slice(0, CAP * 2) : lines).map((line, index) => (
          <span key={index} className={`diff__line diff__line--${line.kind}`}>
            <span className="diff__num">{line.old}</span>
            <span className="diff__num">{line.next}</span>
            <span className="diff__sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span>
            <span className="diff__text">{line.text}</span>
          </span>
        ))}
      </Scroll>
      {long && <button type="button" className="step__more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${lines.length} lines`}</button>}
    </div>
  )
}

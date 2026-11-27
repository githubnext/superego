// github, daemon half: a pull request in words, for the agent: the line its prompt has about the thread's pull request,
// and `pr_view`'s compact account of one (state, checks with how to read a failed run's logs, reviews, unresolved
// review comments).
import { problemText, type PrDetail, type PrSummary } from './shared.ts'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const short = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Its state, checks and review in a parenthesis' words: "open; checks: 2 failing: lint, test; review: changes requested by alice, 3 unresolved comments". */
export function stateLine(pr: PrSummary, detail?: PrDetail): string {
  if (!pr.state) return pr.error ? `state unknown: ${problemText(pr.error)}` : 'state not fetched yet'
  const bits: string[] = [pr.state]
  if (pr.state === 'open' || pr.state === 'draft') {
    const failing = detail?.checkList.filter((c) => c.result === 'fail').map((c) => c.name) ?? []
    if (pr.checks === 'failing') bits.push(`checks: ${pr.failing} failing${failing.length ? `: ${failing.join(', ')}` : ''}`)
    else if (pr.checks !== 'none') bits.push(`checks: ${pr.checks}`)
    const by = (verdict: string) => detail?.reviews.filter((r) => r.verdict === verdict).map((r) => r.who) ?? []
    const review = pr.review === 'changes' ? `changes requested${by('changes').length ? ` by ${by('changes').join(', ')}` : ''}`
      : pr.review === 'approved' ? `approved${by('approved').length ? ` by ${by('approved').join(', ')}` : ''}`
      : pr.review === 'required' ? 'review required' : undefined
    const unresolved = pr.unresolved ? plural(pr.unresolved, 'unresolved comment') : undefined
    if (review || unresolved) bits.push(`review: ${[review, unresolved].filter(Boolean).join(', ')}`)
    if (pr.mergeable === 'conflicting') bits.push('conflicts with its base')
  }
  return bits.join('; ')
}

/** The prompt's line about the thread's open pull requests, or undefined with none. */
export function promptLine(prs: { summary: PrSummary; detail?: PrDetail }[]): string | undefined {
  const open = prs.filter(({ summary }) => summary.state === 'open' || summary.state === 'draft')
  if (!open.length) return undefined
  const each = open.map(({ summary, detail }) => `${summary.repo}#${summary.number}${summary.title ? ` ${JSON.stringify(summary.title)}` : ''} (${stateLine(summary, detail)})`)
  return `This thread's pull request${open.length > 1 ? 's' : ''}: ${each.join('; ')}. pr_view has the details. `
    + "Superego shows its state to the user as it changes: don't wait on or watch its checks yourself (no `gh pr checks --watch`); "
    + 'pr_watch wakes you when they finish or it\'s reviewed.'
}

/** `pr_view`'s account of a pull request: compact, everything to act on. */
export function digest(pr: PrDetail): string {
  const lines = [`${pr.repo}#${pr.number} ${JSON.stringify(pr.title ?? '')}`, pr.url]
  lines.push(`State: ${pr.state ?? 'unknown'}${pr.branch ? `; ${pr.branch} → ${pr.base ?? '?'}` : ''}${pr.head ? ` at ${pr.head.slice(0, 7)}` : ''}${pr.author ? `; by ${pr.author}` : ''}`)
  if (pr.error) lines.push(`Not current: ${problemText(pr.error)}`)
  if (pr.state === 'open' || pr.state === 'draft') lines.push(`Mergeable: ${pr.mergeable === 'conflicting' ? 'no, it conflicts with its base' : pr.mergeable === 'mergeable' ? 'yes' : 'unknown yet'}`)
  const failed = pr.checkList.filter((c) => c.result === 'fail')
  const pending = pr.checkList.filter((c) => c.result === 'pending')
  const passed = pr.checkList.filter((c) => c.result === 'pass' || c.result === 'skipped')
  if (!pr.checkList.length) lines.push('Checks: none')
  else {
    lines.push(`Checks: ${[failed.length && `${failed.length} failing`, pending.length && `${pending.length} pending`, passed.length && `${passed.length} passed`].filter(Boolean).join(', ')}`)
    for (const check of failed) {
      lines.push(`  ✗ ${check.name}${check.url ? ` ${check.url}` : ''}${check.runId ? ` (logs: gh run view ${check.runId} --log-failed)` : ''}`)
    }
    if (pending.length) lines.push(`  pending: ${pending.map((c) => c.name).join(', ')}`)
  }
  const review = pr.review === 'approved' ? 'approved' : pr.review === 'changes' ? 'changes requested' : pr.review === 'required' ? 'review required' : 'none required'
  lines.push(`Review: ${review}`)
  for (const r of pr.reviews) lines.push(`  ${r.who}: ${r.verdict === 'changes' ? 'changes requested' : r.verdict}`)
  if (pr.comments.length) {
    lines.push(`Unresolved review comments (${pr.comments.length}):`)
    for (const c of pr.comments) lines.push(`  ${c.path}${c.line ? `:${c.line}` : ''}${c.outdated ? ' (outdated)' : ''} ${c.who}: ${short(c.body, 400)}${c.url ? ` ${c.url}` : ''}`)
  }
  return lines.join('\n')
}

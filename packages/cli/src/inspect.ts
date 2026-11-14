// `superego extensions`: what each extension on a machine is and does, as `extensions.inspect` says, for an author
// finding out why theirs doesn't show: where it's from, how it stands (and why not), what it registered, who watches
// its values, each profile's load, and with `--thread`, what that thread goes without and why.
import type { ExtensionReport, ExtensionsReport } from '@superego/protocol'

const from = (e: ExtensionReport) => e.source === 'profile' ? `profile ${e.profiles?.join(', ') || '(none now)'}${e.file ? ` · ${e.file}` : ''}` : e.source === 'window' ? 'a window (no daemon half)' : e.source

/** The report, as lines to read. */
export function formatReport(report: ExtensionsReport, machine: string): string {
  const lines = [`Extensions on ${machine} (extension API ${report.api})`, '']
  const order = { failed: 0, refused: 0, 'timed out': 0, off: 1, 'set up': 2 } as const
  for (const e of [...report.extensions].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))) {
    const version = e.version ? ` ${e.version}` : ' (no version: 0.0.0)'
    lines.push(`${e.name}${version}${e.api ? `, needs API ${e.api}` : ''}: ${e.state}${e.required ? ', required' : ''}`)
    lines.push(`  from ${from(e)}`)
    if (e.error) lines.push(`  ${e.state === 'refused' ? 'refused' : e.state === 'timed out' ? 'gave up' : 'error'}: ${e.error}`)
    for (const [kind, names] of Object.entries(e.registered)) lines.push(`  ${kind}: ${names.join('; ')}`)
    for (const w of e.watches) lines.push(`  watched: ${w.value}${w.whole ? `, whole by ${w.whole}` : ''}${w.scopes ? `, in ${w.scopes} scope${w.scopes === 1 ? '' : 's'}` : ''}`)
  }
  if (report.profiles.length) {
    lines.push('', 'Profiles')
    for (const p of report.profiles) lines.push(`${p.scope}:${p.name}: ${p.state}${p.error ? `: ${p.error}` : ''}  (${p.dir})`)
  }
  if (report.thread) {
    lines.push('', `Thread ${report.thread.id}${report.thread.profile ? `, profile ${report.thread.profile}` : ', no profile'}`)
    if (!report.thread.without.length) lines.push('  goes without nothing: every extension here takes part')
    for (const w of report.thread.without) lines.push(`  without ${w.extension}: ${w.why}`)
  }
  lines.push('', 'The window draws what the UI halves register; a UI half that throws says so in its place. Reload a profile: superego extension reload [-P name]')
  return lines.join('\n')
}

// A thread, summed up in a few short lines: the card its row in the sidebar shows while pointed at (or focused), and a
// rail dot's. Each line only when it has something to say.
import { SpelledBadges, Slot, useMachines, useProjects, type MachineEntry } from '@superego/app/ui'
import { rollup, statusShape, statusWord, type ThreadInfo } from '@superego/protocol'
import { IdentificationBadgeIcon, MachineName, modelName, ProviderMark, StatusGlyph } from '@superego/ui'
import { ago } from './ago.ts'

/**
 * What a thread is: its title in full; its state in words, with what it asks, did or failed on; its project, its
 * machine where the sidebar names one, and its marks spelled out (a worktree's branch, say); the model (by its
 * provider's mark) and profile; the thread that started it, or how many it started; what it spent and when it was last
 * active. `tucked`, for a folded row: the threads out of sight under it, summed up by the most pressing.
 */
export function ThreadCard({ machine, thread, tucked = [] }: { machine: MachineEntry; thread: ThreadInfo; tucked?: ThreadInfo[] }) {
  const { projects } = useProjects()
  const several = useMachines().filter((m) => m.state !== 'disabled').length > 1
  const here = projects.filter((p) => p.machine.id === machine.id).flatMap((p) => p.threads)
  const parent = thread.parent ? here.find((t) => t.id === thread.parent) : undefined
  const children = here.filter((t) => t.parent === thread.id).length
  const word = statusWord(thread.status, thread.quiet)
  const why = word && statusShape(thread.status, thread.quiet) !== 'working' ? thread.status.msg : undefined
  // A quiet one that finished counts for nothing here, as on its row.
  const top = rollup(tucked.map((t) => statusShape(t.status, t.quiet) === 'idle' ? { state: 'idle' as const } : t.status))
  const named = several || machine.id !== 'local'
  const spent = thread.cost ? `$${thread.cost.toFixed(2)}` : undefined
  return (
    <div className="thread-card">
      <div className="thread-card__title">{thread.title}</div>
      {word && (
        <div className="thread-card__status">
          <StatusGlyph status={thread.status} quiet={thread.quiet} />
          {/* Working, it says what it waits on, when it waits on something: "Waiting: 3 Claude Agent threads are running". */}
          <span>{statusShape(thread.status, thread.quiet) === 'working' && thread.status.msg ? thread.status.msg : <>{word}{why && `: ${why}`}</>}</span>
        </div>
      )}
      <div className="thread-card__line">
        {thread.project.name}{named && <> · <MachineName machine={machine} /></>}
        <SpelledBadges><Slot name="thread.badge" props={{ machine, thread }} /></SpelledBadges>
      </div>
      {(thread.model || thread.profile) && (
        <div className="thread-card__line">
          {thread.model && <span className="thread-card__fact">{thread.provider && <ProviderMark provider={thread.provider} size={12} />}{modelName(thread.model)}</span>}
          {thread.profile && <span className="thread-card__fact"><IdentificationBadgeIcon size={12} aria-hidden />{thread.profile.name}</span>}
        </div>
      )}
      {parent && <div className="thread-card__line">Started by {parent.title}</div>}
      {children > 0 && (
        <div className="thread-card__line">
          {children === 1 ? '1 sub-thread' : `${children} sub-threads`}
          {top.state !== 'idle' && <span className="thread-card__fact"><StatusGlyph status={top} quiet={top.state === 'working'} />{statusWord(top)}</span>}
        </div>
      )}
      <div className="thread-card__line">{[spent, when(thread.activeAt)].filter(Boolean).join(' · ')}</div>
    </div>
  )
}

/** When it was last active, as a line says it: "just now", "4m ago", "2h ago", then the weekday or the date. */
export function when(at: number, now = Date.now()) {
  const said = ago(at, now)
  return said === 'now' ? 'just now' : /^\d+[mh]$/.test(said) ? `${said} ago` : said
}

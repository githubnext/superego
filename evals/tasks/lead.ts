// Level 2: a profile, no code of its own needed: lead agents that hand work out to threads of their own and review
// what comes back (a prompt, the thread tools, a subagent pattern). Acceptance: in the user's project, a thread started
// with the profile the run made for it (one named like it, else another it made, else the default; its files must
// say it leads: hands work out, to workers, with the thread tools) is given a small
// job in three pieces on a mid-sized model. It passes if it handed work to a child thread, looked at what came back
// (read the child, or acted on its report) before answering, and the job got done (in the project, or in worktrees).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { entriesOf, toolCalls, type Thread } from '../lib/transcript.ts'
import { costOf, LEAD_MODEL, profileDirs, projectProfiles, quiet, sourcesOf, type Acceptance, type Task } from './shared.ts'

/**
 * The lead's job: three pieces that go well apart, and the user saying they want it handed out, as someone who just
 * made lead agents would. Without that, leads whose prompts keep small jobs to themselves (a fair call) did this one
 * alone: the check is that handing out and reviewing work works, not the lead's sense of what's worth handing out.
 */
const JOB = 'Add three small shell scripts to this project, each taking a file path as its first argument: scripts/words.sh ' +
  'prints the number of words in the file, scripts/lines.sh the number of lines, and scripts/chars.sh the number of ' +
  'characters. Give each a test (tests/<name>.test.sh, run with sh), and add a "Scripts" section to README.md saying how to use them. ' +
  "It's small, but I want to see the team at work: hand the pieces out."
const SCRIPTS = { words: '-w', lines: '-l', chars: '-c' } as const

/** Thread tools a lead hands work out with. */
const HANDS_OUT = new Set(['thread_start'])

/** The worktrees of a git repository, but itself. */
function worktreesOf(repo: string): string[] {
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).split('\n')
      .filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).filter((p) => p.replace(/^\/private/, '') !== repo.replace(/^\/private/, ''))
  } catch { return [] }
}

export const lead: Task = {
  id: 'l2-lead',
  level: 2,
  request: 'Add lead agents that hand work out and review it.',
  async accept({ world }) {
    const notes: string[] = []
    const checks = { profile_found: false, briefed: false, delegated: false, reviewed: false, job_done: false, named_profile: false }
    let cost = 0
    const dirs = profileDirs(world)
    notes.push(`profiles: ${dirs.map((d) => d.replace(world.home, '~')).join(', ') || 'none'}`)
    const listed = await projectProfiles(world, notes)
    // The lead: a profile named for it, else one the run made that isn't the default, else the default (changed).
    const named = listed.filter((p) => /lead|review|manag|orchestr|delegat|coordinat/i.test(p.name))
    const pick = named[0] ?? listed.find((p) => p.name !== 'default') ?? listed.find((p) => p.name === 'default')
    if (!pick) return { pass: false, checks, notes, cost }
    checks.profile_found = true
    checks.named_profile = Boolean(named.length)
    // Briefed to lead: its files say so (a plain profile, told to hand work out, might too; that isn't a lead).
    checks.briefed = sourcesOf(pick.dir).some((file) => /thread_start|thread_read|delegat|hand[^.\n]{0,20}out|worker|subagent|sub-agent/i.test(readFileSync(file, 'utf8')))
    notes.push(`lead profile: ${pick.name} (${pick.dir.replace(world.home, '~')})${pick.allowed === false ? ', not allowed' : ''}`)

    // None of the job done already (by a check before this one, run again).
    for (const name of Object.keys(SCRIPTS)) for (const file of [join('scripts', `${name}.sh`), join('tests', `${name}.test.sh`)]) rmSync(join(world.project, file), { force: true })
    // The children it starts take the machine's model: the same mid-sized one, so the check costs little.
    await world.rpc.call('settings.set', { key: 'agent.model', value: LEAD_MODEL })
    const asked = Date.now() - 1000
    let probe: Thread
    try {
      probe = await world.rpc.call('thread.start', { cwd: world.project, title: 'Lead probe', prompt: JOB, ...(pick.name === 'default' ? {} : { profile: pick.name }) })
    } catch (error) {
      notes.push(`thread.start failed: ${(error as Error).message}`)
      return { pass: false, checks, notes, cost }
    }
    // Until the lead and everything under it are quiet (reports take a few seconds to arrive), 10 minutes or $2 at most.
    const family = await quiet(world, probe.id, { ms: 10 * 60_000, cost: 2 })
    notes.push(`after: ${family.stop}; threads: ${family.threads.map((t) => `${t.id === probe.id ? 'lead' : `child ${t.title}`} (${t.status.state}, $${(t.cost ?? 0).toFixed(2)})`).join(', ')}`)
    for (const t of family.threads) cost += await costOf(world, t.id)

    const children = family.threads.filter((t) => t.id !== probe.id)
    const entries = await entriesOf(world.rpc, probe.id)
    const calls = toolCalls(entries)
    notes.push(`lead calls: ${calls.map((c) => c.name).join(', ').slice(0, 400) || 'none'}`)
    checks.delegated = children.length > 0 && calls.some((c) => HANDS_OUT.has(c.name))
    // Reviewed: it read a child (thread_read), or a child's report reached it and it did something with it (a tool call
    // after the report: reading the work, running it, sending the child back) before its last answer.
    const messages = entries.flatMap((e) => e.model ?? [])
    const reportAt = messages.findIndex((m: any) => m.role === 'user' && /From \[[^\]]*\]\(thread:/.test(JSON.stringify(m.content)))
    const callAfter = reportAt >= 0 && messages.slice(reportAt).some((m: any) => m.role === 'assistant' && (m.content ?? []).some((b: any) => b.type === 'toolCall'))
    checks.reviewed = checks.delegated && (calls.some((c) => c.name === 'thread_read') || callAfter)
    notes.push(`review: thread_read ${calls.filter((c) => c.name === 'thread_read').length}×, report ${reportAt >= 0 ? `heard${callAfter ? ', then acted on' : ', not acted on'}` : 'not heard'}`)

    // Done where the work is: the project folder, or a worktree of it (a lead may leave branches for the user to merge).
    const places = [world.project, ...worktreesOf(world.project)]
    const sample = join(world.dir, 'sample.txt')
    writeFileSync(sample, 'one two three\nfour five\nsix\n')
    const done = Object.entries(SCRIPTS).map(([name, flag]) => {
      const expected = execFileSync('sh', ['-c', `wc ${flag} < "${sample}"`], { encoding: 'utf8' }).trim()
      for (const place of places) {
        const script = join(place, 'scripts', `${name}.sh`)
        // Written for this probe: not left by one before it.
        if (!existsSync(script) || statSync(script).mtimeMs < asked) continue
        let said = ''
        try { said = execFileSync('sh', [script, sample], { encoding: 'utf8', timeout: 10_000, cwd: place }).trim() } catch (error) { said = `failed: ${(error as Error).message.slice(0, 100)}` }
        return { name, ok: new RegExp(`(^|\\D)${expected}(\\D|$)`).test(said), where: place === world.project ? 'project' : place.replace(/^\/private/, '').replace(world.home.replace(/^\/private/, ''), '~'), said }
      }
      return { name, ok: false, where: 'missing', said: '' }
    })
    checks.job_done = done.every((d) => d.ok)
    notes.push(`job: ${done.map((d) => `${d.name}.sh ${d.where}${d.said ? ` printed "${d.said.slice(0, 40)}"` : ''}${d.ok ? '' : ' ✗'}`).join('; ')}`)
    return { pass: checks.briefed && checks.delegated && checks.reviewed && checks.job_done, checks, notes, cost } satisfies Acceptance
  },
}

// Level 4: daemon and window together. "Mark threads that touch the database in the sidebar": the daemon half has to
// notice what a thread does (its tool calls, say) and tell clients (facts), and the window draw a mark in the
// `thread.badge` slot from them. The user's project has a SQLite database (db/app.db, db/schema.sql, a note in the
// README). Acceptance: in the project, cheap probe threads (default profile) do one thing each, scripted: one queries
// the database with sqlite3, one counts a README's lines, one edits the schema file. Then, in the installed app's
// window (headless), the sidebar must mark the query thread and not the README one. The schema edit is reported, not
// judged: whether it "touches the database" is the builder's call.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Thread } from '../lib/transcript.ts'
import { costOf, PROBE_MODEL, profileDirs, settle, type Acceptance, type Task } from './shared.ts'

const PROBES = [
  { key: 'query', title: 'Count the users', prompt: "Run exactly this command with your bash tool, once, and nothing else: sqlite3 db/app.db 'select count(*) from users;'. Then reply with only the number." },
  { key: 'readme', title: 'Count README lines', prompt: 'Run exactly this command with your bash tool, once, and nothing else: wc -l README.md. Then reply with only the number.' },
  { key: 'schema', title: 'Note on the schema', prompt: 'Use your edit tool (not bash) to add the line "-- reviewed" at the end of db/schema.sql. Do nothing else, then reply "done".' },
] as const

const SCHEMA = `create table users (id integer primary key, name text not null, created_at text not null);
create table orders (id integer primary key, user_id integer not null references users(id), total_cents integer not null);
`

export const dbBadge: Task = {
  id: 'l4-db-badge',
  level: 4,
  request: 'Mark threads that touch the database in the sidebar.',
  setup(world) {
    const db = join(world.project, 'db')
    mkdirSync(db, { recursive: true })
    writeFileSync(join(db, 'schema.sql'), SCHEMA)
    execFileSync('sqlite3', [join(db, 'app.db')], { input: `${SCHEMA}insert into users (name, created_at) values ('Ada', '2026-01-02'), ('Grace', '2026-02-03');\n` })
    writeFileSync(join(world.project, 'README.md'), '# myproject\n\nA small project of mine.\n\nData lives in SQLite: `db/app.db`, its tables in `db/schema.sql`. Look at it with `sqlite3 db/app.db`.\n')
    execFileSync('git', ['add', '.'], { cwd: world.project, env: { ...process.env, ...world.env } })
    execFileSync('git', ['commit', '-qm', 'Add the database'], { cwd: world.project, env: { ...process.env, ...world.env } })
  },
  async accept({ world, install, out }) {
    const notes: string[] = []
    const checks: Record<string, boolean> = { probes_ran: false, facts_differ: false, query_marked: false, readme_unmarked: false, marked_before_open: false, schema_marked: false }
    let cost = 0
    notes.push(`profiles: ${profileDirs(world).map((d) => d.replace(world.home, '~')).join(', ') || 'none'}`)

    const threads: Record<string, Thread> = {}
    for (const p of PROBES) threads[p.key] = await world.rpc.call<Thread>('thread.create', { cwd: world.project, title: p.title, model: PROBE_MODEL, prompt: p.prompt })
    for (const p of PROBES) { await settle(world, threads[p.key]!.id); cost += await costOf(world, threads[p.key]!.id) }
    const listed = await world.rpc.call<(Thread & { ext?: Record<string, unknown> })[]>('thread.list', {})
    const info = (key: string) => listed.find((t) => t.id === threads[key]!.id)
    checks.probes_ran = PROBES.every((p) => info(p.key)?.status.state === 'done' || info(p.key)?.status.state === 'idle')
    // Facts: what extensions tell clients of each probe (the bundled ones' too: compared, so only a difference counts).
    const facts = (key: string) => JSON.stringify(info(key)?.ext ?? {})
    for (const p of PROBES) notes.push(`${p.key} (${info(p.key)?.status.state}, ${info(p.key)?.profile?.name ?? 'no profile'}): facts ${facts(p.key).slice(0, 300)}`)
    checks.facts_differ = facts('query') !== facts('readme')

    const shots = join(out, 'shots')
    mkdirSync(shots, { recursive: true })
    const resultFile = join(out, 'badge-check.json')
    const env: Record<string, string> = {
      ...world.env, SUPEREGO_HEADLESS: '1',
      EVAL_WINDOW_CHECK: JSON.stringify({ main: join(install.out, 'main', 'main.js'), titles: PROBES.map((p) => p.title), open: PROBES[1].title, shots, out: resultFile }),
    }
    const ran = spawnSync(install.electron, [join(import.meta.dirname, '..', 'lib', 'badge-check.mjs')], { env, encoding: 'utf8', timeout: 200_000 })
    let result: { before?: Badge[]; after?: Badge[]; slots?: unknown[]; screenshot?: string; errors: string[]; console: string[] }
    try { result = JSON.parse(readFileSync(resultFile, 'utf8')) } catch {
      notes.push(`window check didn't report: ${(ran.stderr ?? '').slice(-800)}`)
      return { pass: false, checks, notes, cost }
    }
    if (result.errors.length) notes.push(`window: ${result.errors.join(' | ').slice(0, 600)}`)
    if (result.console.length) notes.push(`console: ${result.console.slice(0, 5).join(' | ').slice(0, 800)}`)
    notes.push(`thread.badge slot: ${JSON.stringify(result.slots ?? []).slice(0, 300)}`)
    const row = (list: Badge[] | undefined, i: number) => list?.find((b) => b.title === PROBES[i]!.title)
    for (const [when, list] of [['before opening one', result.before], ['after', result.after]] as const) {
      notes.push(`${when}: ${PROBES.map((p, i) => `${p.key} ${row(list, i)?.found ? row(list, i)?.badge ? `marked "${row(list, i)?.says}"` : row(list, i)?.failed ? 'FAILED to draw' : 'unmarked' : 'no row'}`).join('; ')}`)
    }
    checks.query_marked = Boolean(row(result.after, 0)?.badge)
    checks.readme_unmarked = Boolean(row(result.after, 1)?.found && !row(result.after, 1)?.badge && !row(result.after, 1)?.failed)
    checks.marked_before_open = Boolean(row(result.before, 0)?.badge)
    checks.schema_marked = Boolean(row(result.after, 2)?.badge)
    return {
      pass: checks.probes_ran! && checks.query_marked! && checks.readme_unmarked!, checks, notes, cost,
      ...(result.screenshot ? { artifacts: { screenshot: result.screenshot } } : {}),
    } satisfies Acceptance
  },
}

type Badge = { title: string; found: boolean; badge: boolean; failed: boolean; says: string }

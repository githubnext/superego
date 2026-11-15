// staff.ts against a made-up daemon: the watchdog on a fake clock, check-ins across a restart (set up again over the
// same kept state), the cap queueing thread_start, and reports (with a real git repository for a child's branch) kept
// past the child's archive until dismissed. Run from a Superego checkout:
//   pnpm exec vitest run --config ~/.superego/profiles/chief-of-staff/test/vitest.config.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

// What 'superego' gives a profile, as little of it as staff.ts uses. Set before staff.ts loads (the shim reads it then).
;(globalThis as { __superegoSdk?: unknown }).__superegoSdk = {
  defineDaemonExtension: (x: unknown) => x, defineAction: (x: unknown) => x, defineExtension: (x: unknown) => x, defineTool: (x: unknown) => x,
  wrapTool: (tool: { name: string }, wrap: unknown) => ({ tool: tool.name, wrap }),
  obj: () => ({}), str: () => ({}), num: () => ({}), opt: () => ({}),
}
let staff: typeof import('../staff.ts').staff
beforeAll(async () => { ({ staff } = await import('../staff.ts')) })
afterEach(() => { vi.useRealTimers() })

const MIN = 60_000
type T = {
  id: string; title: string; cwd: string; createdAt: number; activeAt: number; parent?: string; archived?: boolean; profile?: { name: string; dir: string }
  session: { root: string }; status: { state: string; kind?: string; msg?: string }; ext?: Record<string, unknown>
}

/** A daemon of threads: 1 is the lead (this profile's), the rest whatever a test adds. State kept across set-ups. */
function daemon() {
  const threads: T[] = [{ id: '1', title: 'Lead', cwd: '/p', createdAt: 0, activeAt: 0, profile: { name: 'chief-of-staff', dir: '/x' }, session: { root: '/p' }, status: { state: 'idle' } }]
  const kept = new Map<string, unknown>()
  const sent: [string, string][] = []
  const created: Record<string, unknown>[] = []
  const entries: Record<string, unknown[]> = {}
  const answers: Record<string, string> = {}
  let agent: any
  let values: Record<string, unknown> = {}
  const methods: Record<string, (p: any) => unknown> = {}
  const api = {
    agent: (part: unknown) => { agent = part },
    value: (key: string, initial: unknown) => { values[key] = initial; return { get: () => values[key], set: (v: unknown) => { values[key] = v }, update: (f: (v: unknown) => unknown) => { values[key] = f(values[key]) } } },
    method: (name: string, run: (p: any) => unknown) => { methods[name] = run },
    action: (action: { id: string; run: (p: any) => unknown }) => { methods[action.id] = action.run },
    pane: () => {},
    state: () => ({
      get: async (id: string) => structuredClone(kept.get(id)),
      set: async (id: string, next: unknown) => { kept.set(id, structuredClone(next)) },
      update: async (id: string, edit: (c: unknown) => unknown) => { kept.set(id, structuredClone(edit(structuredClone(kept.get(id))))) },
    }),
    threads: {
      list: async () => threads.filter((t) => !t.archived),
      get: async (id: string) => threads.find((t) => t.id === id) ?? Promise.reject(new Error('not_found')),
      of: (conversationId: number) => String(conversationId),
      create: async (params: Record<string, unknown>) => {
        created.push(params)
        const t: T = { id: String(threads.length + 1), title: String(params.title ?? 'New'), cwd: String(params.cwd), createdAt: Date.now(), activeAt: Date.now(), parent: params.parent as string, session: { root: '/p' }, status: { state: 'working' } }
        threads.push(t)
        return t
      },
      submit: async (id: string, text: string) => { sent.push([id, text]) },
      entries: async (id: string) => entries[id] ?? [],
      lastAnswer: async (id: string) => answers[id],
    },
  }
  const child = (title: string, state = 'working', at = Date.now()) => {
    const t: T = { id: String(threads.length + 1), title, cwd: '/p', createdAt: at - 10 * MIN, activeAt: at, parent: '1', session: { root: '/p' }, status: { state } }
    threads.push(t)
    return t
  }
  return {
    threads, sent, created, entries, answers, child, kept, values: () => values,
    /** Set it up as the daemon would: returns the teardown, and its parts. */
    setUp(options: Parameters<typeof staff>[0]) {
      const stop = (staff(options) as any).setup(api) as () => void
      return { stop, agent, methods }
    },
  }
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const run = async (part: any, name: string, args: unknown) => {
  const tool = part.tools.find((t: any) => t.name === name)
  return (await tool.execute(args, { conversationId: 1 }, {})).output[0].text as string
}

it('tells the lead once when a working child has made no progress for a while, and in which tool call', async () => {
  vi.useFakeTimers({ now: 100 * MIN })
  const d = daemon()
  const stuck = d.child('Smoke', 'working', 100 * MIN)
  d.child('Fine', 'working', 100 * MIN)
  d.child('Done', 'done', 0)
  d.entries[stuck.id] = [{ kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pnpm smoke\nmore' } }] }] }]
  let skew = 0
  const { stop } = d.setUp({ now: () => Date.now() + skew, tickMs: 1_000, stallMs: 15 * MIN })
  await tick(1_000)
  expect(d.sent).toEqual([])
  // 16 minutes on, by its clock: Smoke stalled; Fine moved on meanwhile.
  skew = 16 * MIN
  d.threads.find((t) => t.title === 'Fine')!.activeAt = 100 * MIN + 10 * MIN
  await tick(1_000)
  expect(d.sent).toEqual([['1', `Watchdog: [Smoke](thread:${stuck.id}) has made no progress for 16 min, in bash (\`pnpm smoke\`).`]])
  expect((d.values()['staff.board'] as any)['1'].stalled[stuck.id]).toMatchObject({ call: 'bash (`pnpm smoke`)' })
  // Told once per stall; a new stall after progress is news again.
  await tick(5_000)
  expect(d.sent).toHaveLength(1)
  stuck.activeAt = 100 * MIN + 1
  skew = 40 * MIN
  await tick(1_000)
  expect(d.sent).toHaveLength(2)
  stop()
})

it('fires a check-in when it falls due, after a restart too', async () => {
  vi.useFakeTimers({ now: 0 })
  const d = daemon()
  const first = d.setUp({ tickMs: 1_000 })
  expect(await run(first.agent, 'check_in', { minutes: 20, note: 'Look at the smoke lane' })).toMatch(/^Check-in set for/)
  await run(first.agent, 'check_in', { minutes: 60, note: 'Later' })
  first.stop()
  // The daemon is down a while; set up again, the check-in is still kept, and fires when due.
  await tick(19 * MIN)
  expect(d.sent).toEqual([])
  const again = d.setUp({ tickMs: 1_000 })
  await tick(1 * MIN + 1_000)
  expect(d.sent).toEqual([['1', 'Check-in: Look at the smoke lane']])
  expect((d.kept.get('1') as any).checkIns).toEqual([{ at: 60 * MIN, note: 'Later' }])
  again.stop()
})

it('queues thread_start beyond the cap, and starts the queued as children finish', async () => {
  vi.useFakeTimers({ now: 10 * MIN })
  const d = daemon()
  const { agent, stop } = d.setUp({ tickMs: 1_000, cap: 2 })
  const wrapped = agent.wraps[0].wrap({ name: 'thread_start', execute: async (args: any) => {
    const t = d.child(args.title, 'working')
    return { output: [{ type: 'text', text: `Started ${t.title}` }] }
  } })
  const start = async (title: string) => (await wrapped.execute({ prompt: 'go', title }, { conversationId: 1 }, {})).output[0].text as string
  expect(agent.wraps[0].tool).toBe('thread_start')
  expect(await start('A')).toBe('Started A')
  expect(await start('B')).toBe('Started B')
  expect(await start('C')).toBe('Queued (2 running): it starts when a slot frees up, and you\'ll be told.')
  expect(await start('D')).toBe('Queued (2 running, 1 queued before it): it starts when a slot frees up, and you\'ll be told.')
  await tick(1_000)
  expect(d.created).toEqual([])
  expect((d.values()['staff.board'] as any)['1'].queued.map((q: any) => q.title)).toEqual(['C', 'D'])
  // A finishes: C starts, in the lead's folder, as its child; the lead is told.
  d.threads.find((t) => t.title === 'A')!.status = { state: 'done' }
  await tick(1_000)
  expect(d.created).toEqual([{ prompt: 'go', title: 'C', cwd: '/p', parent: '1' }])
  expect(d.sent).toEqual([['1', expect.stringMatching(/^Started \[C\]\(thread:\d+\) \(id \d+\) from the queue; 1 still queued\.$/)]])
  stop()
})

it('records a report with its branch\'s changes, keeps it past the archive, and drops it on dismiss', async () => {
  // A repository, and a child's worktree on a branch of its own: it commits, main moves on, it rebases and merges.
  const dir = mkdtempSync(join(tmpdir(), 'staff-repo-'))
  const repo = join(dir, 'main')
  const tree = join(dir, 'lane')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' })
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'a')
    git(repo, 'worktree', 'add', '-q', '-b', 'superego/lane', tree, 'HEAD')

    const d = daemon()
    const lane: T = {
      id: '2', title: 'Lane', cwd: tree, createdAt: Date.now() - 10 * MIN, activeAt: Date.now(), parent: '1', session: { root: repo },
      status: { state: 'working' }, ext: { worktrees: { path: tree, branch: 'superego/lane' } },
    }
    d.threads.push(lane)
    const { stop, methods } = d.setUp({ tickMs: 20 })
    const board = () => (d.values()['staff.board'] as any)?.['1']

    // Working, it commits: the board shows what its branch changed so far.
    writeFileSync(join(tree, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(tree, 'b.txt'), 'b\n')
    git(tree, 'add', '.'); git(tree, 'commit', '-qm', 'lane')
    lane.activeAt++
    await vi.waitFor(() => expect(board()?.changes['2']).toMatchObject({ added: 3, removed: 1 }))
    expect(board().reports).toEqual([])

    // Main moves on; it rebases, merges and finishes: reported once, with only its own changes, merged.
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'c')
    git(tree, 'rebase', '-q', 'main')
    git(repo, 'merge', '-q', '--ff-only', 'superego/lane')
    d.answers['2'] = 'Did the lane.\nAll green.'
    lane.status = { state: 'done' }
    lane.activeAt++
    await vi.waitFor(() => expect(board()?.reports).toHaveLength(1))
    expect(board().reports[0]).toMatchObject({
      id: '2', title: 'Lane', outcome: 'done', answer: 'Did the lane.\nAll green.', branch: 'superego/lane', merged: true,
      changes: { added: 3, removed: 1, files: [{ path: 'a.txt', added: 2, removed: 1 }, { path: 'b.txt', added: 1, removed: 0 }] },
    })
    expect((d.kept.get('1') as any).reports).toEqual(board().reports)

    // Archived (as the lead does once it's read the report), it stays on the board; the details still say it's merged.
    lane.archived = true
    await vi.waitFor(() => expect(board()?.changes).toEqual({}))
    expect(board().reports).toHaveLength(1)
    expect(await methods['staff.details']!({ id: '1' })).toEqual([{ id: '2', answer: null, merged: true }])

    // Dismissed: gone from the board and the state, and not reported again.
    await methods['staff.dismiss']!({ id: '1', child: '2' })
    expect(board().reports).toEqual([])
    expect((d.kept.get('1') as any).reports).toEqual([])
    await new Promise((r) => setTimeout(r, 100))
    expect(board().reports).toEqual([])
    stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('reports a question and an error, takes a later report over an earlier one, and dismisses all at once', async () => {
  vi.useFakeTimers({ now: 100 * MIN })
  const d = daemon()
  const asks = d.child('Asks', 'working')
  const fails = d.child('Fails', 'working')
  const { stop, methods } = d.setUp({ tickMs: 1_000 })
  const reports = () => (d.values()['staff.board'] as any)['1'].reports
  await tick(1_000)
  expect(reports()).toEqual([])
  asks.status = { state: 'blocked', kind: 'question', msg: 'Which colour?' }
  fails.status = { state: 'error', msg: 'Out of credit' }
  await tick(1_000)
  expect(reports().map((r: any) => [r.title, r.outcome, r.answer])).toEqual([['Fails', 'error', 'Out of credit'], ['Asks', 'question', 'Which colour?']])
  // Answered, it finishes: its report says so now, in place of the question.
  asks.status = { state: 'done' }
  asks.activeAt += MIN
  d.answers[asks.id] = 'Blue it is.'
  await tick(1_000)
  expect(reports().map((r: any) => [r.title, r.outcome, r.answer])).toEqual([['Asks', 'done', 'Blue it is.'], ['Fails', 'error', 'Out of credit']])
  await methods['staff.dismiss']!({ id: '1' })
  expect(reports()).toEqual([])
  await tick(1_000)
  expect(reports()).toEqual([])
  stop()
})

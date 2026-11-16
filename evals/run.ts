// `pnpm eval`: how well agents extend Superego with only the help it ships. Each run gets a fresh, sandboxed home and a
// daemon of its own on an installed build (lib/install.ts, lib/env.ts), asks for a task by one route (Ego, or a plain
// thread) on one model, waits for the work to finish (or a time or cost limit), checks the result against the running
// daemon (tasks/*.ts), and reads the transcript for where it got lost (lib/analyze.ts). One JSON line per run in
// evals/results/<batch>/runs.jsonl; transcripts beside it; and a line per run in evals/history.csv (committed), the
// trend across batches. A batch spends no more than its budget, all told (agents, acceptance probes, analysis), and
// picks up where it left off when run again.
//
//   pnpm eval [--batch b] [--budget 60] [--plan regular|spike] [--tasks l1-weather,l3-kanban] [--models opus,sol]
//             [--routes ego,thread] [--runs 5] [--parallel 3] [--minutes 20] [--run-cap 6]
//   pnpm eval --batch spike --recheck <run,run>    check finished runs again (after fixing a task's acceptance)
//   pnpm eval --batch spike --rollup-only          redo the rolled-up list and the summary (--summary-only: the summary)
//   pnpm eval --batch spike --history              add a batch's runs to history.csv (one from before it was kept)
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeRun, helpUsed, rollUp, type Analysis } from './lib/analyze.ts'
import { makeWorld, sleep, type World } from './lib/env.ts'
import { install, REPO } from './lib/install.ts'
import { addMetrics, allThreads, condensed, entriesOf, metricsOf, noMetrics, spent, toolCalls, type Thread } from './lib/transcript.ts'
import { kanban } from './tasks/kanban.ts'
import { profileDirs, sourcesOf, type Acceptance, type Task } from './tasks/shared.ts'
import { weather } from './tasks/weather.ts'
import { lead } from './tasks/lead.ts'
import { dbBadge } from './tasks/db-badge.ts'

const { values: args } = parseArgs({
  options: {
    batch: { type: 'string', default: new Date().toISOString().slice(0, 10) }, budget: { type: 'string', default: '60' }, plan: { type: 'string', default: 'regular' },
    tasks: { type: 'string' }, models: { type: 'string' }, routes: { type: 'string' }, runs: { type: 'string' },
    parallel: { type: 'string', default: '3' }, minutes: { type: 'string', default: '20' }, 'run-cap': { type: 'string', default: '6' },
    'rollup-only': { type: 'boolean' }, 'history': { type: 'boolean' }, 'summary-only': { type: 'boolean' }, recheck: { type: 'string' }, root: { type: 'string', default: '/tmp/sge' }, rebuild: { type: 'boolean' },
  },
})

const TASKS: Record<string, Task> = { [weather.id]: weather, [lead.id]: lead, [kanban.id]: kanban, [dbBadge.id]: dbBadge }
const MODELS: Record<string, string> = { opus: 'anthropic/claude-opus-5-5', sol: 'openai/gpt-6.1-sol', haiku: 'anthropic/claude-haiku-4-5' }
const NUDGE = 'Yes, go ahead. Use your judgement on the details.'

type Planned = { task: Task; model: string; modelKey: string; route: 'ego' | 'thread'; index: number; runId: string }

/**
 * What a plan runs, and on what setup.
 * - `regular` (the trend line): Opus through Ego, every task, 5 runs each; the app's extensions as a user has them, the
 *   SDK's types installed, per-run analysis on a cheaper model.
 * - `spike`: the first batch's setup, to compare with it: L1 and L3, Opus by both routes and Sol through Ego, 3 runs
 *   each; only a few optional extensions on, no types installed up front, analysis on Opus.
 */
const PLANS = {
  regular: { tasks: ['l1-weather', 'l2-lead', 'l3-kanban', 'l4-db-badge'], combos: [['opus', 'ego']], runs: 5, extensions: 'defaults', types: true, analysis: 'claude-sonnet-5-5' },
  spike: { tasks: ['l1-weather', 'l3-kanban'], combos: [['opus', 'ego'], ['opus', 'thread'], ['sol', 'ego']], runs: 3, extensions: 'spike', types: false, analysis: 'claude-opus-5-5' },
} as const satisfies Record<string, { tasks: string[]; combos: [string, 'ego' | 'thread'][]; runs: number; extensions: 'spike' | 'defaults'; types: boolean; analysis: string }>
const thePlan = PLANS[args.plan as keyof typeof PLANS]
if (!thePlan) throw new Error(`No plan ${args.plan}: ${Object.keys(PLANS).join(', ')}`)

/** The plan's runs, by model (the first is the trend line; a cut budget cuts the last), task by task within an index. */
function plan(): Planned[] {
  const runs = Number(args.runs ?? thePlan.runs)
  const pick = <T,>(list: string | undefined, all: T[], key: (t: T) => string) => list ? all.filter((t) => list.split(',').includes(key(t))) : all
  const tasks = pick(args.tasks, thePlan.tasks.map((id) => TASKS[id]!), (t) => t.id)
  const combos: [string, 'ego' | 'thread'][] = !args.models && !args.routes
    ? thePlan.combos.map(([m, r]) => [m, r] as [string, 'ego' | 'thread'])
    : pick(args.models, Object.keys(MODELS), (m) => m).flatMap((m) => pick(args.routes, ['ego', 'thread'] as const, (r) => r).map((r) => [m, r] as [string, 'ego' | 'thread']))
  const out: Planned[] = []
  // Model by model (the first is the trend line; a cut budget cuts the last), and within one by index, so a cut leaves
  // each route and task with some runs.
  for (const modelKey of [...new Set(combos.map(([m]) => m))]) for (let index = 1; index <= runs; index++) {
    for (const [m, route] of combos) if (m === modelKey) for (const task of tasks) {
      out.push({ task, model: MODELS[modelKey]!, modelKey, route, index, runId: `${task.id}.${modelKey}.${route}.${index}` })
    }
  }
  return out
}

const batchDir = join(REPO, 'evals', 'results', args.batch!)
mkdirSync(batchDir, { recursive: true })
const recordsFile = join(batchDir, 'runs.jsonl')
const readRecords = () => existsSync(recordsFile) ? readFileSync(recordsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

const budget = Number(args.budget)
const ledger = { done: readRecords().reduce((sum: number, r: any) => sum + (r.totalCost ?? 0), 0) + (existsSync(join(batchDir, 'rollup.json')) ? JSON.parse(readFileSync(join(batchDir, 'rollup.json'), 'utf8')).cost ?? 0 : 0), live: new Map<string, number>() }
const total = () => ledger.done + [...ledger.live.values()].reduce((a, b) => a + b, 0)
/** Kept back for the analysis passes and the rollup. */
const RESERVE = 3

/** The trend across batches, committed: a line per run, appended as each is recorded. */
const HISTORY = join(REPO, 'evals', 'history.csv')
const HISTORY_COLUMNS = ['date', 'commit', 'model', 'route', 'task', 'pass', 'cost', 'turns', 'minutes', 'batch', 'plan', 'run']
function appendHistory(r: any) {
  if (!existsSync(HISTORY)) writeFileSync(HISTORY, `${HISTORY_COLUMNS.join(',')}\n`)
  const row = [r.startedAt.slice(0, 10), r.commit, r.model, r.route, r.task, r.pass ? 1 : 0, r.cost.toFixed(2), r.turns, (r.wallSeconds / 60).toFixed(1), r.batch, r.plan ?? 'spike', r.runId]
  appendFileSync(HISTORY, `${row.join(',')}\n`)
}

/**
 * Answer what the run's threads ask the user, as a user who leaves it to them would: "go ahead" to a question
 * (ask_user), and a form (ask_ui) submitted as it came, its defaults (a choice with none: its first option). How many
 * it answered.
 */
async function answerQuestions(world: World, threads: Thread[]): Promise<number> {
  let answered = 0
  for (const thread of threads.filter((t) => t.status.state === 'blocked')) {
    for (const call of toolCalls(await entriesOf(world.rpc, thread.id)).filter((c) => c.result === undefined)) {
      const answer = call.name === 'ask_user' ? { id: 'ask-user.answer', params: { id: call.id, answer: NUDGE } }
        : call.name === 'ask_ui' ? { id: 'answer-ui.answer', params: { id: call.id, values: defaultsOf(call.args?.blocks ?? []), button: 'submit' } }
        : undefined
      if (answer) await world.rpc.call('action.run', { ...answer, exposure: 'cli' }).then(() => answered++, () => {})
    }
  }
  return answered
}

/** A form's inputs as it came: each one's default, or a choice's first option. */
function defaultsOf(blocks: any[], into: Record<string, unknown> = {}): Record<string, unknown> {
  for (const block of blocks) {
    if (Array.isArray(block?.blocks)) defaultsOf(block.blocks, into)
    if (!block?.id || block.type === 'buttons') continue
    if (block.default !== undefined) into[block.id] = block.default
    else if (block.type === 'choice' || block.type === 'select') { const first = block.options?.[0]; if (first) into[block.id] = block.multiple ? [first.value ?? first.label] : first.value ?? first.label }
    else if (block.type === 'switch') into[block.id] = false
  }
  return into
}

/** Whether anything in the home was written since `since`, besides the daemon's own data. */
function wroteAnything(home: string, since: number): boolean {
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 8) return false
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (dir === join(home, '.superego') && !['profiles'].includes(entry.name)) continue
      if (entry.isDirectory()) { if (walk(path, depth + 1)) return true }
      else if (statSync(path).mtimeMs > since) return true
    }
    return false
  }
  return walk(home, 0)
}

async function runOne(p: Planned, inst: ReturnType<typeof install>) {
  const out = join(batchDir, 'runs', p.runId)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const worldDir = join(args.root!, 'runs', `${args.batch}-${p.runId}`)
  rmSync(worldDir, { recursive: true, force: true })
  const log = (line: string) => { console.log(`[${p.runId}] ${line}`); appendFileSync(join(out, 'log.txt'), `${new Date().toISOString()} ${line}\n`) }
  const startedAt = Date.now()
  const runCap = Number(args['run-cap'])
  const limitMs = Number(args.minutes) * 60_000
  let world: World | undefined
  let stopReason = 'finished'
  let nudged = false
  let answered = 0
  /** The run's own threads, as they were when its work ended: not the acceptance's probes and what they start. */
  let workIds = new Set<string>()
  let acceptance: Acceptance = { pass: false, checks: {}, notes: [], cost: 0 }
  let threads: Thread[] = []
  const transcripts: { thread: Thread; entries: any[] }[] = []
  try {
    world = await makeWorld(worldDir, inst, { model: p.model, extensions: thePlan.extensions, types: thePlan.types })
    p.task.setup?.(world)
    log(`world at ${worldDir}; asking by ${p.route} on ${p.model}`)
    const ask = async (text: string) => {
      if (p.route === 'ego') return (await world!.rpc.call<Thread>('action.run', { id: 'ego.ask', params: { prompt: text }, exposure: 'cli' })).id
      return (await world!.rpc.call<Thread>('thread.start', { cwd: world!.project, prompt: text })).id
    }
    const askedAt = Date.now()
    const first = await ask(p.task.request)
    let quiet = 0
    while (true) {
      await sleep(5000)
      threads = await allThreads(world.rpc)
      const cost = spent(threads)
      ledger.live.set(p.runId, cost)
      const working = threads.filter((t) => t.status.state === 'working')
      const over = cost > runCap ? 'cost-limit' : total() > budget - RESERVE ? 'budget' : Date.now() - startedAt > limitMs ? 'time-limit' : undefined
      if (over) {
        stopReason = over
        log(`stopping: ${over} ($${cost.toFixed(2)}, ${Math.round((Date.now() - startedAt) / 1000)}s)`)
        for (const t of working) await world.rpc.call('thread.stop', { thread: t.id }).catch(() => {})
        await sleep(3000)
        break
      }
      // A question to the user (ask_user): they'd answer it; the harness says go ahead, a few times at most.
      const asked = threads.some((t) => t.status.state === 'blocked') && answered < 3 ? await answerQuestions(world, threads) : 0
      if (asked) { answered += asked; quiet = 0; log(`answered ${asked} question${asked > 1 ? 's' : ''}`); continue }
      quiet = working.length ? 0 : quiet + 1
      if (quiet < 3) continue
      // Quiet: done, unless the agent stopped to ask before building anything; then the user says go ahead, once.
      if (!nudged && !wroteAnything(world.home, askedAt)) {
        nudged = true
        quiet = 0
        log('nothing built yet: nudging')
        if (p.route === 'ego') await ask(NUDGE)
        else await world.rpc.call('thread.send', { thread: first, text: NUDGE })
        continue
      }
      break
    }
    threads = await allThreads(world.rpc)
    workIds = new Set(threads.map((t) => t.id))
    const profiles = profileDirs(world)
    for (const dir of profiles) for (const file of sourcesOf(dir)) {
      const to = join(out, 'profiles', file.replace(world.home, 'home'))
      mkdirSync(join(to, '..'), { recursive: true })
      writeFileSync(to, readFileSync(file))
    }
    log(`work ended (${stopReason}), $${spent(threads).toFixed(2)}; checking`)
    try { acceptance = await p.task.accept({ world, install: inst, out }) } catch (error) {
      acceptance = { pass: false, checks: {}, notes: [`acceptance threw: ${(error as Error).stack}`], cost: 0 }
    }
    log(`${acceptance.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(acceptance.checks)}`)
    for (const thread of await allThreads(world.rpc)) transcripts.push({ thread, entries: await entriesOf(world.rpc, thread.id) })
  } catch (error) {
    stopReason = `harness-error: ${(error as Error).message}`
    log(stopReason)
  } finally {
    await world?.stop()
  }
  const wallSeconds = Math.round((Date.now() - startedAt) / 1000)

  // The agent's work: every thread but the acceptance probes and seeded ones.
  const theWork = transcripts.filter(({ thread }) => workIds.has(thread.id))
  let metrics = noMetrics()
  for (const { entries } of theWork) metrics = addMetrics(metrics, metricsOf(entries))
  const ego = theWork.find(({ thread }) => thread.hidden)
  const text = theWork.map(({ thread, entries }) => condensed(thread, entries)).join('\n\n')
  writeFileSync(join(out, 'transcript.md'), text)
  writeFileSync(join(out, 'entries.json'), JSON.stringify(transcripts.map(({ thread, entries }) => ({ thread, entries })), null, 1))
  const used = helpUsed(theWork.flatMap(({ entries }) => entries), inst.dir)

  ledger.live.set(p.runId, metrics.cost + acceptance.cost)
  const clipped = text.length > 400_000 ? `${text.slice(0, 250_000)}\n…[cut]…\n${text.slice(-150_000)}` : text
  const { analysis, cost: analysisCost, error: analysisError } = await analyzeRun({ request: p.task.request, route: p.route, transcript: clipped, pass: acceptance.pass, checks: acceptance.checks, notes: acceptance.notes, model: thePlan.analysis })
  if (analysis) writeFileSync(join(out, 'analysis.json'), JSON.stringify(analysis, null, 2))

  const record = {
    batch: args.batch, runId: p.runId, commit: inst.commit, model: p.model, route: p.route, task: p.task.id, level: p.task.level, index: p.index,
    plan: args.plan, startedAt: new Date(startedAt).toISOString(), wallSeconds, stopReason, nudged, answered,
    pass: acceptance.pass, checks: acceptance.checks, acceptanceNotes: acceptance.notes, artifacts: acceptance.artifacts ?? {},
    threads: theWork.map(({ thread }) => ({ id: thread.id, title: thread.title, hidden: Boolean(thread.hidden), cwd: thread.cwd.replace(/^\/private/, '').replace(worldDir, '<run>'), status: thread.status.state, profile: thread.profile?.name })),
    thinking: theWork.flatMap(({ entries }) => entries).flatMap((e) => e.model ?? []).find((m: any) => m.role === 'assistant' && m.thinkingLevel)?.thinkingLevel,
    tokens: metrics.tokens, cost: metrics.cost, turns: metrics.turns, toolCalls: metrics.toolCalls, failedToolCalls: metrics.failedToolCalls,
    ego: ego ? metricsOf(ego.entries) : undefined,
    help: used, analysis, analysisError,
    acceptanceCost: acceptance.cost, analysisCost, totalCost: metrics.cost + acceptance.cost + analysisCost,
  }
  appendFileSync(recordsFile, JSON.stringify(record) + '\n')
  appendHistory(record)
  ledger.live.delete(p.runId)
  ledger.done += record.totalCost
  log(`recorded: ${record.pass ? 'PASS' : 'FAIL'}, $${record.totalCost.toFixed(2)} (batch $${total().toFixed(2)} of $${budget})`)
}

/**
 * Check finished runs again (after a fix to a task's acceptance): their worlds' daemons started again, the acceptance
 * and the analysis redone, and their records replaced, with what that cost added.
 */
async function recheck(ids: string[]) {
  const inst = install(args.root!)
  const records = readRecords()
  for (const record of records.filter((r: any) => ids.includes(r.runId))) {
    const task = TASKS[record.task]!
    const out = join(batchDir, 'runs', record.runId)
    const world = await makeWorld(join(args.root!, 'runs', `${args.batch}-${record.runId}`), inst, { model: record.model, reuse: true, extensions: thePlan.extensions, types: thePlan.types })
    let acceptance: Acceptance
    try { acceptance = await task.accept({ world, install: inst, out }) } catch (error) {
      acceptance = { pass: false, checks: {}, notes: [`acceptance threw: ${(error as Error).stack}`], cost: 0 }
    } finally { await world.stop() }
    const text = readFileSync(join(out, 'transcript.md'), 'utf8')
    const clipped = text.length > 400_000 ? `${text.slice(0, 250_000)}\n…[cut]…\n${text.slice(-150_000)}` : text
    const { analysis, cost: analysisCost, error: analysisError } = await analyzeRun({ request: task.request, route: record.route, transcript: clipped, pass: acceptance.pass, checks: acceptance.checks, notes: acceptance.notes, model: thePlan.analysis })
    if (analysis) writeFileSync(join(out, 'analysis.json'), JSON.stringify(analysis, null, 2))
    Object.assign(record, {
      pass: acceptance.pass, checks: acceptance.checks, acceptanceNotes: acceptance.notes, artifacts: acceptance.artifacts ?? {}, analysis, analysisError,
      rechecked: true, acceptanceCost: record.acceptanceCost + acceptance.cost, analysisCost: record.analysisCost + analysisCost,
      totalCost: record.totalCost + acceptance.cost + analysisCost,
    })
    console.log(`[${record.runId}] rechecked: ${acceptance.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(acceptance.checks)}`)
  }
  writeFileSync(recordsFile, records.map((r: any) => JSON.stringify(r)).join('\n') + '\n')
  // Their lines in the history, as they stand now.
  if (existsSync(HISTORY)) {
    const lines = readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean)
    const kept = lines.filter((line) => { const cells = line.split(','); return !(cells[9] === args.batch && ids.includes(cells[11]!)) })
    writeFileSync(HISTORY, `${kept.join('\n')}\n`)
    for (const record of records.filter((r: any) => ids.includes(r.runId))) appendHistory(record)
  }
}

async function main() {
  if (args.recheck) return recheck(args.recheck.split(','))
  if (args.history) { for (const record of readRecords()) appendHistory(record); return }
  if (!args['rollup-only'] && !args['summary-only']) {
    const inst = install(args.root!, { rebuild: Boolean(args.rebuild) })
    const done = new Set(readRecords().map((r: any) => r.runId))
    const queue = plan().filter((p) => !done.has(p.runId))
    console.log(`eval: ${queue.length} runs to go, $${total().toFixed(2)} of $${budget} spent; installed build ${inst.commit} at ${inst.dir}`)
    const workers = Array.from({ length: Number(args.parallel) }, async (_, w) => {
      await sleep(w * 20_000) // staggered: the first minutes of a run cost the most
      while (queue.length) {
        // Room for one more run at its cap, beside what's running, before the reserve.
        const room = budget - RESERVE - total() - (ledger.live.size * 1.5)
        if (room < Math.min(Number(args['run-cap']), 3)) { console.log(`eval: budget too tight for more runs ($${total().toFixed(2)} spent); skipping ${queue.map((q) => q.runId).join(', ')}`); queue.length = 0; break }
        const next = queue.shift()!
        ledger.live.set(next.runId, 0)
        await runOne(next, inst).catch((error) => console.error(`[${next.runId}] crashed:`, error))
        ledger.live.delete(next.runId)
      }
    })
    await Promise.all(workers)
  }
  const records = readRecords()
  const kept = join(batchDir, 'rollup.json')
  const rollup = args['summary-only'] && existsSync(kept) ? JSON.parse(readFileSync(kept, 'utf8')) : await rollUp(records.map((r: any) => ({ runId: r.runId, task: r.task, route: r.route, model: r.model, pass: r.pass, analysis: r.analysis as Analysis | undefined })))
  writeFileSync(join(batchDir, 'rollup.json'), JSON.stringify(rollup, null, 2))
  writeFileSync(join(batchDir, 'summary.md'), summary(records, rollup))
  console.log(`eval: done. $${(records.reduce((s: number, r: any) => s + r.totalCost, 0) + rollup.cost).toFixed(2)} spent. ${join(batchDir, 'summary.md')}`)
}

/** Pass rates and metrics by model × route × task, and the ranked stumbles. */
function summary(records: any[], rollup: Awaited<ReturnType<typeof rollUp>>) {
  const groups = new Map<string, any[]>()
  for (const r of records) groups.set(`${r.model} | ${r.route} | ${r.task}`, [...(groups.get(`${r.model} | ${r.route} | ${r.task}`) ?? []), r])
  const avg = (list: any[], f: (r: any) => number) => list.reduce((s, r) => s + f(r), 0) / list.length
  const rows = [...groups].map(([key, list]) => `| ${key} | ${list.filter((r) => r.pass).length}/${list.length} | ${Math.round(avg(list, (r) => r.wallSeconds) / 60 * 10) / 10} | $${avg(list, (r) => r.cost).toFixed(2)} | ${Math.round(avg(list, (r) => r.turns))} | ${Math.round(avg(list, (r) => r.toolCalls))} | ${Math.round(avg(list, (r) => r.failedToolCalls))} | ${Math.round(avg(list, (r) => r.tokens.output) / 1000)}k | ${list.map((r) => r.stopReason).filter((s) => s !== 'finished').join(', ') || '-'} |`)
  const checks = records.map((r) => `| ${r.runId} | ${r.pass ? 'pass' : 'FAIL'} | ${Object.entries(r.checks).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join(', ')} | $${r.cost.toFixed(2)} | ${Math.round(r.wallSeconds / 60)}m |`)
  const items = rollup.items.map((i, n) => `${n + 1}. **${i.summary}** (${i.runs} runs${i.fatal ? `, fatal in ${i.fatal}` : ''}; ${i.area}). Fix: ${i.fix}`)
  return `# Eval: ${args.batch}\n\n| model | route | task | pass | min | agent cost | turns | tool calls | failed calls | output tokens | stopped early |\n|---|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n## Runs\n\n| run | result | checks | cost | time |\n|---|---|---|---|---|\n${checks.join('\n')}\n\n## Where they got lost\n\n${items.join('\n')}\n\nTotal spent: $${(records.reduce((s, r) => s + r.totalCost, 0) + rollup.cost).toFixed(2)} (analysis included).\n`
}

await main()

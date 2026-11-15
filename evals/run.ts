// `pnpm eval`: how well agents extend Superego with only the help it ships. Each run gets a fresh, sandboxed home and a
// daemon of its own on an installed build (lib/install.ts, lib/env.ts), asks for a task by one route (Ego, or a plain
// thread) on one model, waits for the work to finish (or a time or cost limit), checks the result against the running
// daemon (tasks/*.ts), and reads the transcript for where it got lost (lib/analyze.ts). One JSON line per run in
// evals/results/<batch>/runs.jsonl; transcripts beside it. A batch spends no more than its budget, all told (agents,
// acceptance probes, analysis), and picks up where it left off when run again.
//
//   pnpm eval [--batch spike] [--budget 60] [--plan spike] [--tasks l1-weather,l3-kanban] [--models opus,sol]
//             [--routes ego,thread] [--runs 3] [--parallel 3] [--minutes 20] [--run-cap 6]
//   pnpm eval --batch spike --recheck <run,run>    check finished runs again (after fixing a task's acceptance)
//   pnpm eval --batch spike --rollup-only          redo the rolled-up list and the summary (--summary-only: the summary)
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeRun, helpUsed, rollUp, type Analysis } from './lib/analyze.ts'
import { makeWorld, sleep, type World } from './lib/env.ts'
import { install, REPO } from './lib/install.ts'
import { addMetrics, allThreads, condensed, entriesOf, metricsOf, noMetrics, spent, type Thread } from './lib/transcript.ts'
import { kanban } from './tasks/kanban.ts'
import { profileDirs, sourcesOf, type Acceptance, type Task } from './tasks/shared.ts'
import { weather } from './tasks/weather.ts'

const { values: args } = parseArgs({
  options: {
    batch: { type: 'string', default: 'spike' }, budget: { type: 'string', default: '60' }, plan: { type: 'string', default: 'spike' },
    tasks: { type: 'string' }, models: { type: 'string' }, routes: { type: 'string' }, runs: { type: 'string', default: '3' },
    parallel: { type: 'string', default: '3' }, minutes: { type: 'string', default: '20' }, 'run-cap': { type: 'string', default: '6' },
    'rollup-only': { type: 'boolean' }, 'summary-only': { type: 'boolean' }, recheck: { type: 'string' }, root: { type: 'string', default: '/tmp/sge' }, rebuild: { type: 'boolean' },
  },
})

const TASKS: Record<string, Task> = { [weather.id]: weather, [kanban.id]: kanban }
const MODELS: Record<string, string> = { opus: 'anthropic/claude-opus-5-5', sol: 'openai/gpt-6.1-sol', haiku: 'anthropic/claude-haiku-4-5' }
const NUDGE = 'Yes, go ahead. Use your judgement on the details.'

type Planned = { task: Task; model: string; modelKey: string; route: 'ego' | 'thread'; index: number; runId: string }

/** The spike: Opus on both tasks by both routes, then Sol through Ego, so Sol is what a tight budget cuts. */
function plan(): Planned[] {
  const runs = Number(args.runs)
  const pick = <T,>(list: string | undefined, all: T[], key: (t: T) => string) => list ? all.filter((t) => list.split(',').includes(key(t))) : all
  const tasks = pick(args.tasks, Object.values(TASKS), (t) => t.id)
  const combos: [string, 'ego' | 'thread'][] = args.plan === 'spike' && !args.models && !args.routes
    ? [['opus', 'ego'], ['opus', 'thread'], ['sol', 'ego']]
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
  let acceptance: Acceptance = { pass: false, checks: {}, notes: [], cost: 0 }
  let threads: Thread[] = []
  const transcripts: { thread: Thread; entries: any[] }[] = []
  try {
    world = await makeWorld(worldDir, inst, { model: p.model })
    log(`world at ${worldDir}; asking by ${p.route} on ${p.model}`)
    const ask = async (text: string) => {
      if (p.route === 'ego') return (await world!.rpc.call<Thread>('action.run', { id: 'ego.ask', params: { prompt: text }, exposure: 'cli' })).id
      return (await world!.rpc.call<Thread>('thread.create', { cwd: world!.project, prompt: text })).id
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
        for (const t of working) await world.rpc.call('thread.abort', { id: t.id }).catch(() => {})
        await sleep(3000)
        break
      }
      quiet = working.length ? 0 : quiet + 1
      if (quiet < 3) continue
      // Quiet: done, unless the agent stopped to ask before building anything; then the user says go ahead, once.
      if (!nudged && !wroteAnything(world.home, askedAt)) {
        nudged = true
        quiet = 0
        log('nothing built yet: nudging')
        if (p.route === 'ego') await ask(NUDGE)
        else await world.rpc.call('thread.submit', { id: first, text: NUDGE })
        continue
      }
      break
    }
    threads = await allThreads(world.rpc)
    for (const thread of threads) transcripts.push({ thread, entries: await entriesOf(world.rpc, thread.id) })
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
  } catch (error) {
    stopReason = `harness-error: ${(error as Error).message}`
    log(stopReason)
  } finally {
    await world?.stop()
  }
  const wallSeconds = Math.round((Date.now() - startedAt) / 1000)

  // The agent's work: every thread but the acceptance probes and seeded ones.
  const theWork = transcripts.filter(({ thread }) => !/^(Weather probe|Board probe|Live check|Fix the login bug|Write the release notes|Plan the Q3 roadmap)/.test(thread.title))
  let metrics = noMetrics()
  for (const { entries } of theWork) metrics = addMetrics(metrics, metricsOf(entries))
  const ego = theWork.find(({ thread }) => thread.hidden)
  const text = theWork.map(({ thread, entries }) => condensed(thread, entries)).join('\n\n')
  writeFileSync(join(out, 'transcript.md'), text)
  writeFileSync(join(out, 'entries.json'), JSON.stringify(transcripts.map(({ thread, entries }) => ({ thread, entries })), null, 1))
  const used = helpUsed(theWork.flatMap(({ entries }) => entries), inst.dir)

  ledger.live.set(p.runId, metrics.cost + acceptance.cost)
  const clipped = text.length > 400_000 ? `${text.slice(0, 250_000)}\n…[cut]…\n${text.slice(-150_000)}` : text
  const { analysis, cost: analysisCost, error: analysisError } = await analyzeRun({ request: p.task.request, route: p.route, transcript: clipped, pass: acceptance.pass, checks: acceptance.checks, notes: acceptance.notes })
  if (analysis) writeFileSync(join(out, 'analysis.json'), JSON.stringify(analysis, null, 2))

  const record = {
    batch: args.batch, runId: p.runId, commit: inst.commit, model: p.model, route: p.route, task: p.task.id, level: p.task.level, index: p.index,
    startedAt: new Date(startedAt).toISOString(), wallSeconds, stopReason, nudged,
    pass: acceptance.pass, checks: acceptance.checks, acceptanceNotes: acceptance.notes, artifacts: acceptance.artifacts ?? {},
    threads: theWork.map(({ thread }) => ({ id: thread.id, title: thread.title, hidden: Boolean(thread.hidden), cwd: thread.cwd.replace(/^\/private/, '').replace(worldDir, '<run>'), status: thread.status.state, profile: thread.profile?.name })),
    thinking: theWork.flatMap(({ entries }) => entries).flatMap((e) => e.model ?? []).find((m: any) => m.role === 'assistant' && m.thinkingLevel)?.thinkingLevel,
    tokens: metrics.tokens, cost: metrics.cost, turns: metrics.turns, toolCalls: metrics.toolCalls, failedToolCalls: metrics.failedToolCalls,
    ego: ego ? metricsOf(ego.entries) : undefined,
    help: used, analysis, analysisError,
    acceptanceCost: acceptance.cost, analysisCost, totalCost: metrics.cost + acceptance.cost + analysisCost,
  }
  appendFileSync(recordsFile, JSON.stringify(record) + '\n')
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
    const world = await makeWorld(join(args.root!, 'runs', `${args.batch}-${record.runId}`), inst, { model: record.model, reuse: true })
    let acceptance: Acceptance
    try { acceptance = await task.accept({ world, install: inst, out }) } catch (error) {
      acceptance = { pass: false, checks: {}, notes: [`acceptance threw: ${(error as Error).stack}`], cost: 0 }
    } finally { await world.stop() }
    const text = readFileSync(join(out, 'transcript.md'), 'utf8')
    const clipped = text.length > 400_000 ? `${text.slice(0, 250_000)}\n…[cut]…\n${text.slice(-150_000)}` : text
    const { analysis, cost: analysisCost, error: analysisError } = await analyzeRun({ request: task.request, route: record.route, transcript: clipped, pass: acceptance.pass, checks: acceptance.checks, notes: acceptance.notes })
    if (analysis) writeFileSync(join(out, 'analysis.json'), JSON.stringify(analysis, null, 2))
    Object.assign(record, {
      pass: acceptance.pass, checks: acceptance.checks, acceptanceNotes: acceptance.notes, artifacts: acceptance.artifacts ?? {}, analysis, analysisError,
      rechecked: true, acceptanceCost: record.acceptanceCost + acceptance.cost, analysisCost: record.analysisCost + analysisCost,
      totalCost: record.totalCost + acceptance.cost + analysisCost,
    })
    console.log(`[${record.runId}] rechecked: ${acceptance.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(acceptance.checks)}`)
  }
  writeFileSync(recordsFile, records.map((r: any) => JSON.stringify(r)).join('\n') + '\n')
}

async function main() {
  if (args.recheck) return recheck(args.recheck.split(','))
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

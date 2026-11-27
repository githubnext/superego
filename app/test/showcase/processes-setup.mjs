// Writes what test/processes.mjs looks at, before the app starts: `node processes-setup.mjs <data dir> <project> <turns.jsonl>`.
// The project's scripts (a dev server that says it's ready, a test watcher, a build that fails with a type error),
// a process an earlier daemon left that went with a restart of the machine (its pid gone: lost as the daemon starts),
// and the turns of a thread that starts the tests and a build, is woken by the build failing, reads its output and
// says what it'll fix.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [home, project, out] = process.argv.slice(2)
const write = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }

write(join(project, 'package.json'), `${JSON.stringify({
  name: 'ledger', version: '0.4.0', type: 'module',
  scripts: { test: 'node --test', 'test:watch': 'node scripts/watch.mjs', dev: 'node scripts/dev.mjs', build: 'node scripts/build.mjs', storybook: 'node scripts/dev.mjs' },
}, null, 2)}\n`)
const esc = (code) => `\\u001b[${code}m`
write(join(project, 'scripts/dev.mjs'), `// A dev server's output, then it serves on.
const out = (s) => process.stdout.write(s + '\\n')
out('')
out('  ${esc('1;32')}VITE${esc(0)} ${esc(32)}v6.2.0${esc(0)}  ${esc(2)}ready in${esc(0)} ${esc(1)}312${esc(0)} ms')
out('')
out('  ${esc(32)}➜${esc(0)}  ${esc(1)}Local${esc(0)}:   ${esc(36)}http://localhost:${esc(1)}5173${esc(0)}${esc(36)}/${esc(0)}')
out('  ${esc(2)}➜  Network: use --host to expose${esc(0)}')
setInterval(() => {}, 1 << 30)
`)
write(join(project, 'scripts/watch.mjs'), `// A test watcher's first pass, then it watches.
const out = (s) => process.stdout.write(s + '\\n')
for (const [name, ms] of [['parses day/month/year dates', 0.9], ['rejects a 13th month', 0.3], ['sums a month by category', 1.4], ['imports quoted commas', 2.1]]) out('${esc(32)}✔${esc(0)} ' + name + ' ${esc(2)}(' + ms + 'ms)${esc(0)}')
out('${esc(34)}ℹ${esc(0)} tests 4  pass 4  fail 0')
out('${esc(2)}Watching src/ for changes…${esc(0)}')
setInterval(() => {}, 1 << 30)
`)
write(join(project, 'scripts/build.mjs'), `// A type check that fails.
const out = (s) => process.stdout.write(s + '\\n')
out('src/import.ts: checking 14 files')
setTimeout(() => {
  out("src/import.ts(42,7): ${esc(31)}error${esc(0)} ${esc(2)}TS2322${esc(0)}: Type 'number | undefined' is not assignable to type 'number'.")
  out("  ${esc(2)}Type 'undefined' is not assignable to type 'number'.${esc(0)}")
  out('')
  out('Found 1 error in src/import.ts${esc(2)}:42${esc(0)}')
  process.exit(2)
}, 2500)
`)

// Left by an earlier daemon, running then; its pid gone now, as after a restart of the machine.
const id = 'p_5t0rybk1'
const ago = Date.now() - 26 * 3600_000
write(join(home, 'extensions/processes/processes.json'), `${JSON.stringify({ processes: [{
  id, name: 'storybook', owner: { folder: project }, cwd: project, command: 'npm run storybook', env: {}, grace: 5000, notify: 'failure',
  restart: 'never', keep: false, by: { user: true }, state: 'running', pid: 2147483646, pidStart: 'Mon Jan  1 00:00:00 2024', run: 1,
  startedAt: ago, base: 0, start: 0, createdAt: ago,
}] }, null, 1)}\n`)
write(join(home, `extensions/processes/${id}/output.log`), '\n> ledger@0.4.0 storybook\n> node scripts/dev.mjs\n\n  storybook 8.6 started\n')

let ids = 0
const call = (name, args) => ({ type: 'toolCall', id: `processes-${++ids}`, name, arguments: args })
const turns = [
  { content: [{ type: 'text', text: 'Starting the tests in watch mode and a full build.' }, call('process_start', { command: 'npm run test:watch' }), call('process_start', { command: 'npm run build' })], stopReason: 'toolUse' },
  { content: [{ type: 'text', text: "Both are running; I'll pick this up when the build ends." }], stopReason: 'stop' },
  { content: [call('process_logs', { id: 'npm run build', lines: 40 })], stopReason: 'toolUse' },
  { content: [{ type: 'text', text: '`total` can be `undefined` when an account has no entries in the month. `sumMonth` falls back to `0` now; rebuilding once the tests pass.' }], stopReason: 'stop' },
]
writeFileSync(out, turns.map((message) => JSON.stringify({ at: 0, provider: 'showcase', model: 'showcase', message: { role: 'assistant', ...message } })).join('\n') + '\n')

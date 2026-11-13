// A machine running an older Superego, for tests: `node older.mjs <commit|none> <committedAt> <command...>` runs the
// command (one piping stdio to a daemon) and rewrites what its hello says of the commit, or drops it (`none`).
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [commit, committedAt, ...command] = process.argv.slice(2)
const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
process.stdin.pipe(child.stdin)
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const message = JSON.parse(line)
    const machine = message.result?.machine
    if (machine && 'build' in machine) {
      delete machine.commit
      delete machine.committedAt
      if (commit !== 'none') Object.assign(machine, { commit, committedAt: Number(committedAt) })
      line = JSON.stringify(message)
    }
  } catch {}
  process.stdout.write(line + '\n')
})
child.on('close', (code) => process.exit(code ?? 0))

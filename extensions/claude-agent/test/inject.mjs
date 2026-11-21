// Between a test's `claude` and the Agent SDK: passes Claude Code's output through, and after each `system:init` adds
// the messages a file holds (then empties it), as Claude Code would send them. For what the mock API can't make Claude
// Code say: its report of a Claude plan's limits (`rate_limit_event`), sent only for a plan's sign-in.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'

const file = process.argv[2]
for await (const line of createInterface({ input: process.stdin })) {
  process.stdout.write(`${line}\n`)
  if (line.includes('"subtype":"init"') && existsSync(file)) {
    const said = readFileSync(file, 'utf8')
    rmSync(file)
    process.stdout.write(said.endsWith('\n') ? said : `${said}\n`)
  }
}

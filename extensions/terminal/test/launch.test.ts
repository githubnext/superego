// A resumed program in each shell there is here, for real: started at its first prompt after the user's startup files
// (which set its PATH), its words reaching it as given, never as shell; suspended back to the prompt, and the prompt
// the user's as the program exits. What the shell read is gone by then.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asJob, firstProcess, shellKind } from '../src/launch.ts'
import { spawnPty } from '../src/pty.ts'

const which = (...files: string[]) => files.find((file) => existsSync(file))
const SHELLS = [
  { name: 'zsh', file: which('/bin/zsh', '/usr/bin/zsh'), math: '$((2+2))' },
  { name: 'bash', file: which('/bin/bash', '/usr/bin/bash'), math: '$((2+2))' },
  { name: 'dash', file: which('/bin/dash', '/usr/bin/dash'), math: '$((2+2))' },
  // Not on most machines: FISH=<its path> to try it.
  { name: 'fish', file: which(process.env.FISH ?? '', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'), math: '(math 2+2)' },
]

let made: string[] = []
afterEach(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); made = [] })

/** A home whose startup files (as `name` reads them) put `show` on the PATH, and say they ran. */
function home(name: string) {
  const dir = mkdtempSync(join(tmpdir(), 'superego-launch-'))
  made.push(dir)
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'show'), `#!/bin/sh\nprintf '[%s]' "$@"; printf ' from=%s zdotdir=%s env=%s\\n' "$FROM_STARTUP" "\${ZDOTDIR-unset}" "\${ENV-unset}"\n`)
  chmodSync(join(dir, 'bin', 'show'), 0o755)
  const posix = `export FROM_STARTUP=${name}; export PATH="$HOME/bin:$PATH"\n`
  if (name === 'zsh') {
    // Its own ZDOTDIR, set as many do, in ~/.zshenv: its .zshrc is read from there.
    writeFileSync(join(dir, '.zshenv'), 'export ZDOTDIR=$HOME/zdot\n')
    mkdirSync(join(dir, 'zdot'))
    writeFileSync(join(dir, 'zdot', '.zshrc'), posix)
  }
  if (name === 'bash') writeFileSync(join(dir, '.bash_profile'), posix)
  if (name === 'dash') writeFileSync(join(dir, '.profile'), posix)
  if (name === 'fish') {
    mkdirSync(join(dir, '.config', 'fish'), { recursive: true })
    writeFileSync(join(dir, '.config', 'fish', 'config.fish'), `set -gx FROM_STARTUP fish; set -gx PATH $HOME/bin $PATH\n`)
  }
  return dir
}

/** `file` started as a terminal would to resume `argv`, in `dir` as its home: its output, and typing. */
function start(file: string, argv: string[], dir: string, launch: 'job' | 'first' = 'job') {
  const shell = { file, args: ['-l'] }
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', XDG_CONFIG_HOME: join(dir, '.config'), XDG_DATA_HOME: join(dir, '.local', 'share') }
  const launchDir = join(dir, 'launch')
  const job = launch === 'job' ? asJob(shell, argv, { dir: launchDir, env, parent: process.pid })! : { args: firstProcess(shell, argv), env }
  const pty = spawnPty(file, job.args, { cwd: dir, cols: 120, rows: 30, env: job.env })
  let output = ''
  let exited = false
  pty.onData((text) => { output += text })
  pty.onExit(() => { exited = true })
  const waitFor = async (text: string) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
      if (output.includes(text)) return
    }
    throw new Error(`Waited for ${JSON.stringify(text)}; the terminal showed ${JSON.stringify(output)}`)
  }
  return { pty, launchDir, waitFor, get output() { return output }, get exited() { return exited } }
}

it('knows the shells it can resume a job in', () => {
  expect(['/bin/zsh', '-zsh', '/usr/bin/bash', '/opt/homebrew/bin/fish', '/bin/sh', '/bin/dash', '/bin/ksh'].map(shellKind)).toEqual(['zsh', 'zsh', 'bash', 'fish', 'sh', 'sh', 'sh'])
  expect(shellKind('/usr/bin/nu')).toBeUndefined()
})

for (const { name, file, math } of SHELLS) {
  describe.skipIf(!file)(name, () => {
    it('runs it at the first prompt, after the startup files, its words as given; ^Z and exiting go back to the prompt', async () => {
      const dir = home(name)
      const term = start(file!, ['show', '$(echo nope)', 'a b', '', "it's", '*', '\\n'], dir)
      const zdotdir = name === 'zsh' ? join(dir, 'zdot') : 'unset'
      await term.waitFor(`[$(echo nope)][a b][][it's][*][\\n] from=${name} zdotdir=${zdotdir} env=unset`)
      expect(existsSync(term.launchDir)).toBe(false)
      term.pty.write('show again\r')
      await term.waitFor(`[again] from=${name} zdotdir=${zdotdir} env=unset`)
      // Nothing of the resume's left about, nor complaining at a prompt.
      term.pty.write(name === 'fish' ? 'echo left=(set | grep -c __superego_)\r' : 'echo "left=$(set | grep -c __superego_)"\r')
      await term.waitFor('left=0')
      expect(term.output).not.toMatch(/not found|error/i)
      term.pty.kill('SIGKILL')

      // A program the shell can suspend: back at the prompt with ^Z.
      const sleeping = start(file!, ['sh', '-c', 'echo sleeping; sleep 30'], home(name))
      await sleeping.waitFor('sleeping')
      await new Promise((r) => setTimeout(r, 300))
      sleeping.pty.write('\x1a')
      await new Promise((r) => setTimeout(r, 300))
      sleeping.pty.write(`echo back-${math}\r`)
      await sleeping.waitFor('back-4')
      sleeping.pty.kill('SIGKILL')
    })

    it('runs the program on the PATH, never a builtin of its name', async () => {
      const term = start(file!, ['eval', 'echo pwned'], home(name))
      term.pty.write(`echo after-${math}\r`)
      await term.waitFor('after-4')
      expect(term.output).not.toContain('pwned')
      term.pty.kill('SIGKILL')
    })

    it('runs one that was the first process as that, exiting with it', async () => {
      const term = start(file!, ['show', '$(echo nope)', ''], home(name), 'first')
      await term.waitFor(`[$(echo nope)][] from=${name}`)
      for (const end = Date.now() + 5000; !term.exited && Date.now() < end;) await new Promise((r) => setTimeout(r, 20))
      expect(term.exited).toBe(true)
    })
  })
}

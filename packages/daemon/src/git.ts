// git, as the daemon runs it: to find the repository a thread's folder is in.
import { execFile } from 'node:child_process'

/** git in `cwd`: its output, trimmed; its own message when it fails. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, out, err) =>
    error ? fail(new Error(String(err).trim() || error.message)) : done(String(out).trim())))
}

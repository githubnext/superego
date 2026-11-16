// Standing instructions from AGENTS.md files: the one in the folder agents share (~/.agents), and those from the
// filesystem's root down to a thread's folder. The core's `agents-md` extension puts them in every agent's prompt.
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A value for an XML-like attribute (`path="…"`), its special characters escaped. */
export const quote = (value: string) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Standing instructions: `AGENTS.md` in `agentsDir`, then each one from the filesystem's root down to `cwd`, the
 * nearest last, each tagged with where it came from.
 */
export async function agentsInstructions(agentsDir: string, cwd: string | undefined): Promise<string | undefined> {
  const files = [join(agentsDir, 'AGENTS.md')]
  if (cwd) {
    const chain: string[] = []
    for (let dir = cwd; ; dir = dirname(dir)) {
      chain.unshift(join(dir, 'AGENTS.md'))
      if (dirname(dir) === dir) break
    }
    for (const file of chain) if (!files.includes(file)) files.push(file)
  }
  const parts: string[] = []
  for (const file of files) {
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile() || info.size > 256 * 1024) continue
    const text = (await readFile(file, 'utf8').catch(() => '')).trim()
    if (text) parts.push(`<file path="${quote(file)}">\n${text}\n</file>`)
  }
  return parts.length ? parts.join('\n\n') : undefined
}

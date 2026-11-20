// Standing instructions from AGENTS.md files: the one in the folder agents share (~/.agents), and the project's, from
// its top down to a thread's folder (project-files.ts: within the project, and only what no one else could have put
// there). The core's `agents-md` extension puts them in every agent's prompt.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { projectFolders, trusted } from './project-files.ts'

/** A value for an XML-like attribute (`path="…"`), its special characters escaped. */
export const quote = (value: string) => value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Standing instructions: `AGENTS.md` in `agentsDir`, then each of the project's from its top down to `cwd`, the nearest
 * last, each tagged with where it came from.
 */
export async function agentsInstructions(agentsDir: string, cwd: string | undefined): Promise<string | undefined> {
  const files = [join(agentsDir, 'AGENTS.md')]
  for (const dir of cwd ? projectFolders(cwd).reverse() : []) {
    const file = join(dir, 'AGENTS.md')
    if (!files.includes(file) && trusted(file)) files.push(file)
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

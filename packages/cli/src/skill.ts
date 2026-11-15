// The `superego` skill, for agents: SKILL.md (what Superego is, how to start an extension, and an index) and its topics,
// the other pages in ../skill, the guide among them, with the guide's diagrams and examples in folders beside it. The
// CLI prints them (`--skill [topic]`); the app's daemon offers the folder to its threads as a skill (the skills
// extension), so it's always the installed app's own. A build copies the folder to out/skill, beside out/main.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcError } from '@superego/protocol'

const built = fileURLToPath(new URL('../skill/', import.meta.url))
const unpacked = built.replace(/\.asar([\\/])/, '.asar.unpacked$1')

/**
 * The skill's folder. In a packaged app it's unpacked from the archive (`app.asar.unpacked/out/skill`), where any
 * program reads it: an agent's `cat` as well as Electron's patched `fs`.
 */
export const SKILL_DIR = unpacked !== built && existsSync(unpacked) ? unpacked : built

/** The topics `--skill <topic>` prints: every page beside SKILL.md. */
export const skillTopics = () => readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md') && f !== 'SKILL.md').map((f) => f.slice(0, -3)).sort()

export function skill(topic?: string): string {
  if (!topic) return readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')
  if (!skillTopics().includes(topic)) throw new RpcError('usage', `No topic ${topic}. Topics: ${skillTopics().join(', ')}`)
  return readFileSync(join(SKILL_DIR, `${topic}.md`), 'utf8')
}

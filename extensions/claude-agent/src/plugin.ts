// Superego's skills for Claude Code: a local plugin of the daemon's own (`<dataDir>/claude-agent/plugin`) whose skills
// are links to the folders given (the app's `superego` skill, in the build the daemon runs), loaded into each turn's
// session with the Agent SDK's `plugins`. Never the user's `~/.claude`, nor `.claude/skills` in the thread's folder:
// Claude Code reads the plugin for Superego's sessions only. Made again each time the daemon starts, so the links point
// at the build it runs.
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/** The plugin's name: its skills are `superego:<skill>` in Claude Code. */
export const PLUGIN = 'superego'

/** A skill folder's name, as its SKILL.md says it (`name:` in its frontmatter), else the folder's. */
async function skillName(dir: string) {
  const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  return /^name:\s*['"]?([\w.-]+)['"]?\s*$/m.exec(front)?.[1] ?? basename(resolve(dir))
}

/** Make the plugin in `dir`, with `skills` (folders, each with a SKILL.md) linked in: the folder to load. */
export async function writePlugin(dir: string, skills: readonly string[]) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await mkdir(join(dir, 'skills'), { recursive: true })
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), `${JSON.stringify({
    name: PLUGIN, description: "Superego's own skills, for its Claude Agent threads",
  }, null, 2)}\n`)
  for (const skill of skills) await symlink(resolve(skill), join(dir, 'skills', await skillName(skill)), 'dir')
  return dir
}

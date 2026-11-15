// Skills from ~/.agents/skills, the folder agents share, and the app's own: each a folder with a SKILL.md (its name and
// description in front matter, its instructions below). The agent sees the skills' names and descriptions and reads one when it fits;
// a message that names one with `$name` or `/skill:name` brings that skill's instructions along with it.
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { quote } from './shared.ts'

export type Skill = {
  name: string
  description: string
  /** Its SKILL.md. */
  path: string
  /** Only when asked for by name: left out of what the agent is offered (`disable-model-invocation: true`). */
  manual: boolean
}

/** The front matter's plain keys: `key: value`, quoted or not, and `>`/`|` blocks of indented lines. */
export function frontMatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { data: {}, body: source }
  const data: Record<string, string> = {}
  const lines = match[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!)
    if (!line) continue
    const [, key, raw] = line as unknown as [string, string, string]
    let value = raw.trim()
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) block.push(lines[++i]!.trim())
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim()
    } else if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    data[key] = value
  }
  return { data, body: source.slice(match[0].length) }
}

/**
 * The skills in `dir` (`<dir>/<folder>/SKILL.md`), then those in `own` (each a skill's folder), by name; the first of a
 * name wins. A folder without a SKILL.md isn't one.
 */
export async function listSkills(dir: string, own: string[] = []): Promise<Skill[]> {
  const folders = await readdir(dir).catch(() => [] as string[])
  const skills = await Promise.all([...folders.filter((name) => !name.startsWith('.')).map((name) => join(dir, name)), ...own].map(async (folder): Promise<Skill | undefined> => {
    const path = join(folder, 'SKILL.md')
    const source = await readFile(path, 'utf8').catch(() => undefined)
    if (source === undefined) return undefined
    const { data } = frontMatter(source)
    const name = (data.name || basename(folder)).trim()
    if (!/^[\w][\w.-]*$/.test(name)) return undefined
    return { name, description: data.description ?? '', path, manual: data['disable-model-invocation'] === 'true' }
  }))
  const byName = new Map<string, Skill>()
  for (const skill of skills) if (skill && !byName.has(skill.name)) byName.set(skill.name, skill)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const escape = (value: string) => value.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)

/** What the agent is told about the skills it may use: each one's name, what it's for, and where to read it. */
export function skillsPrompt(skills: Skill[]): string | undefined {
  const offered = skills.filter((skill) => !skill.manual)
  if (!offered.length) return undefined
  return [
    'Skills are instructions for particular tasks. When a task matches a skill\'s description, read its file with the read tool before you start, and follow it. A skill\'s file may name other files next to it; paths in it are relative to its folder.',
    '',
    ...offered.map((skill) => `<skill name="${quote(skill.name)}" location="${quote(skill.path)}">${escape(skill.description.replace(/\s+/g, ' ').trim())}</skill>`),
  ].join('\n')
}

/**
 * The skills a message asks for by name, in the order it names them: `$name` or `/skill:name`, at the start of a word.
 * A name that is no skill is left alone (`$HOME`, a price).
 */
export function mentionedSkills(text: string, skills: Skill[]): Skill[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const found = new Map<string, Skill>()
  for (const match of text.matchAll(/(?<![^\s([{"'`])(?:\$|\/skill:)([\w][\w.-]*)/g)) {
    // A trailing full stop ends the sentence, not the name.
    const name = match[1]!.replace(/\.+$/, '')
    const skill = byName.get(name)
    if (skill && !found.has(name)) found.set(name, skill)
  }
  return [...found.values()]
}

/** A skill a message asked for, as the text that goes with it: its instructions whole, tagged with where they came from (see SENT). */
export async function skillBlock(skill: Skill): Promise<string> {
  const { body } = frontMatter(await readFile(skill.path, 'utf8'))
  return `<skill name="${quote(skill.name)}" location="${quote(skill.path)}">\nThe user asked for this skill. Follow its instructions; paths in it are relative to ${quote(dirname(skill.path))}.\n\n${body.trim()}\n</skill>`
}

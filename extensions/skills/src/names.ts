// Naming a skill in the composer: the word at the caret that names one, and the skills it could be; and the skills a
// sent message named, found again in it to show.
import { SENT, unquote, type SkillInfo } from './shared.ts'

/**
 * The skill being named at the caret, if one is: `$na` or `/skill:na` at the start of a word, or `/na` opening the
 * message (a slash elsewhere is more likely a path). `start` is where its trigger begins.
 */
export function skillAt(text: string, caret: number): { start: number; trigger: '$' | '/skill:' | '/'; query: string } | undefined {
  if (/^[\w.-]/.test(text.slice(caret))) return undefined
  const match = /(?:^|[\s([{"'`])(\$|\/skill:|\/)([\w.-]*)$/.exec(text.slice(0, caret))
  if (!match) return undefined
  const trigger = match[1] as '$' | '/skill:' | '/'
  const start = caret - match[1]!.length - match[2]!.length
  if (trigger === '/' && start !== 0) return undefined
  return { start, trigger, query: match[2]! }
}

/** Skills whose names hold `query`, those starting with it first. */
export const matchSkills = (skills: SkillInfo[], query: string) => {
  const q = query.toLowerCase()
  return skills.filter((skill) => skill.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
    .slice(0, 8)
}

/** A sent message's skills (each a block the daemon half added, see SENT), and which blocks they were. */
export function sentSkills(blocks: readonly { type: string; text?: string }[]): { items: { name: string; path: string }[]; blocks: number[] } {
  const items: { name: string; path: string }[] = []
  const at: number[] = []
  blocks.forEach((block, index) => {
    const tag = block.type === 'text' ? SENT.exec(block.text ?? '') : null
    if (!tag) return
    items.push({ name: unquote(tag[1]!), path: unquote(tag[2]!) })
    at.push(index)
  })
  return { items, blocks: at }
}

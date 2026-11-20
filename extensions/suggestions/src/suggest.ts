// Asking a model what the user might send next: the end of the conversation in, a few short messages out. One of them
// may run a skill (`$commit`), picked from the machine's skills the model is told about.
import type { Suggestion } from './shared.ts'

type Message = { role: string; content: string | { type: string; text?: string }[] }

/** A skill as the skills extension lists it (`skills.list`); `manual`: only when asked for by name. */
export type SkillInfo = { name: string; description: string; manual?: boolean }

export const SYSTEM = `You suggest what the user might send next to a coding agent.
You get the end of their conversation. Reply with a JSON array of at most 3 messages the user is likely to send next, in their own voice, as they would type them: "Run the tests", "Commit this", "Yes, write the migration".
Lead with the most likely next step. When the agent asked the user something, answer it. Each message under 60 characters.
Reply [] when nothing is likely. Reply with the JSON array only.`

/** How much of the prompt the skills may take, in characters, and how many there may be at most. */
export const SKILLS_BUDGET = 2_000
export const SKILLS_MAX = 30
/** A skill's description as the model reads it: its first sentence, cut to this. */
const DESCRIPTION = 90

/** A description in a line: its first sentence, whitespace collapsed, cut at a word to `DESCRIPTION` characters. */
export function brief(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat
  if (sentence.length <= DESCRIPTION) return sentence
  return `${sentence.slice(0, DESCRIPTION).replace(/\s+\S*$/, '')}…`
}

/**
 * The skills to tell the model about, each as `name: description`, within `SKILLS_BUDGET` characters and `SKILLS_MAX`
 * skills. Those only asked for by name are left out. When they don't all fit, the ones the conversation brings up go
 * first: named in it, then by how many of their description's words it uses (a word's stem), then the shorter.
 */
export function offeredSkills(skills: SkillInfo[], transcript: string): { skill: SkillInfo; line: string }[] {
  const all = skills.filter((skill) => !skill.manual).map((skill) => ({ skill, line: `${skill.name}: ${brief(skill.description)}` }))
  const size = (list: { line: string }[]) => list.reduce((sum, { line }) => sum + line.length + 1, 0)
  if (all.length <= SKILLS_MAX && size(all) <= SKILLS_BUDGET) return all
  const said = stems(transcript.replace(/^(User|Agent): /gm, ''))
  const score = ({ skill }: { skill: SkillInfo }) =>
    (new RegExp(`(?<![\\w-])${skill.name.replace(/[.]/g, '\\.')}(?![\\w-])`, 'i').test(transcript) ? 100 : 0) + [...stems(skill.description)].filter((w) => said.has(w)).length
  const ranked = all.map((offer) => ({ offer, score: score(offer) })).sort((a, b) => b.score - a.score || a.offer.line.length - b.offer.line.length)
  const kept: typeof all = []
  let used = 0
  for (const { offer } of ranked) {
    if (kept.length === SKILLS_MAX) break
    if (used + offer.line.length + 1 > SKILLS_BUDGET) continue
    kept.push(offer)
    used += offer.line.length + 1
  }
  return kept
}

/** Words too common to tell skills apart. */
const COMMON = new Set(['user', 'agent', 'when', 'with', 'from', 'this', 'that', 'them', 'they', 'your', 'into', 'about', 'asks', 'asked', 'using', 'should', 'skill', 'used', 'have', 'what', 'like', 'also', 'other', 'only', 'more', 'then', 'their', 'there', 'want', 'need', 'make'])
/** A word as ranking compares it: its first five letters, enough to match "commit" with "committed". */
const stem = (word: string) => word.toLowerCase().slice(0, 5)
/** The telling words of a text, as stems. */
const stems = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !COMMON.has(w)).map(stem))

/** What the model is asked: the instructions, with the skills it may suggest, and the conversation. */
export function requestOf(transcript: string, skills: { line: string }[]): { systemPrompt: string; prompt: string } {
  if (!skills.length) return { systemPrompt: SYSTEM, prompt: transcript }
  return {
    systemPrompt: `${SYSTEM}
The user can also run a skill, instructions the agent follows for a kind of task: $ and its name, with a few words after when they help, as "$commit" or "$pr draft for the date fix". When one of these skills clearly fits the next step, one message may run it. At most one, only one of these, and none when none clearly fits:
${skills.map(({ line }) => line).join('\n')}`,
    prompt: transcript,
  }
}

/** The conversation's text as a model reads it: who said what, tool calls left out, at most `limit` characters from the end. */
export function transcriptOf(messages: Message[], limit = 12_000): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = (typeof message.content === 'string' ? message.content : message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')).trim()
    if (text) lines.push(`${message.role === 'user' ? 'User' : 'Agent'}: ${text}`)
  }
  const all = lines.join('\n\n')
  return all.length > limit ? `…${all.slice(-limit)}` : all
}

/** The messages in a model's reply: its last JSON array of strings (in a code fence, even), short and distinct, else none. */
export function promptsOf(reply: string): string[] {
  for (const [json] of [...reply.matchAll(/\[[^[\]]*\]/g)].reverse()) {
    try {
      const list = JSON.parse(json) as unknown
      if (!Array.isArray(list)) continue
      return [...new Set(list.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter((p) => p && p.length <= 120))]
    } catch { /* not JSON: an earlier one may be */ }
  }
  return []
}

/**
 * The suggestions in a model's reply, at most three. One that opens by naming a skill (`$name`, `/skill:name` or
 * `/name`) runs it, written `$name` as the composer sends it; only the first that names one of `skills` stays, and
 * one naming any other is dropped.
 */
export function suggestionsOf(reply: string, skills: SkillInfo[]): Suggestion[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const out: Suggestion[] = []
  let ranSkill = false
  for (const prompt of promptsOf(reply)) {
    const named = /^(?:\$|\/skill:|\/)(\w[\w.-]*?)\.*(?=\s|$)(.*)$/s.exec(prompt)
    if (!named) { out.push({ text: prompt }); continue }
    const skill = byName.get(named[1]!)
    if (!skill || ranSkill) continue
    ranSkill = true
    out.push({ text: `$${skill.name}${named[2]!}`, skill: { name: skill.name, description: skill.description.replace(/\s+/g, ' ').trim() } })
  }
  return [...new Map(out.map((s) => [s.text, s])).values()].slice(0, 3)
}

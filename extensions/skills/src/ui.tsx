// skills, UI half: naming a skill as you type. `$` (or `/skill:`, or `/` opening the message) offers the thread's
// machine's skills in the composer, and a skill a message named shows as a chip under it (its instructions went along
// whole, see daemon.ts).
import { call, Chip, defineUiExtension, type Completion, type ComposerWhere } from '@superego/app/ui'
import { SparkleIcon } from '@superego/ui'
import { matchSkills, sentSkills, skillAt } from './names.ts'
import { about, LIST, type SkillInfo } from './shared.ts'

/**
 * The machine's skills, read once for each word being named (where it starts in which thread) and filtered as it
 * grows, as the daemon reads every SKILL.md to list them.
 */
let listed: { key: string; skills: Promise<SkillInfo[]> } | undefined
const skillsFor = ({ machine, thread }: ComposerWhere, start: number) => {
  const key = `${machine.id}\u0000${thread.id}\u0000${start}`
  if (listed?.key !== key) listed = { key, skills: call<SkillInfo[]>(machine.id, LIST).catch(() => []) }
  return listed.skills
}

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.composer.complete({
      title: 'Skills',
      word: skillAt,
      async items(word, where): Promise<Completion[]> {
        // `/name` opening the message completes as `/skill:name`: a bare slash is more often a path.
        const trigger = word.trigger === '$' ? '$' : '/skill:'
        return matchSkills(await skillsFor(where, word.start), word.query)
          .map((skill) => ({ label: `${trigger}${skill.name}`, detail: skill.description, insert: `${trigger}${skill.name} ` }))
      },
    })
    superego.composer.sentWith({ read: sentSkills, component: Chips })
  },
})

/** The skills a message named, a chip each, like a file's. */
function Chips({ items }: { items: { name: string; path: string }[] }) {
  return items.map((skill) => (
    <Chip key={skill.name} title={skill.path} icon={<SparkleIcon size={13} weight="fill" color="var(--superego-accent)" aria-hidden />}>{skill.name}</Chip>
  ))
}

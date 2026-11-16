// skills, daemon half: the skills in the folder agents share (see skills.ts), and the app's own (its `superego` skill).
// The agent is told what each is for in a prompt section; a message that names one (`$commit`, `/skill:commit`)
// carries its instructions, through a send transform; the composer completes names from `skills.list`; and a data
// view (`skills.view`) lists them to browse.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { defineDaemonExtension, type DaemonExtension } from '@superego/daemon'
import { join } from 'node:path'
import type { ViewContent } from '@superego/protocol'
import { about, LIST, VIEW, type SkillInfo } from './shared.ts'
import { listSkills, mentionedSkills, skillBlock, skillsPrompt } from './skills.ts'

export type SkillsOptions = {
  /**
   * Skills the app brings, each a skill's folder (with its SKILL.md): offered where they are, so they're always the
   * installed app's own. A skill of the same name in the agents' folder is offered instead.
   */
  own?: string[]
}

export function skillsExtension({ own = [] }: SkillsOptions = {}): DaemonExtension {
  return defineDaemonExtension({
    ...about,
    setup(superego) {
      const dir = join(superego.agentsDir, 'skills')
      const skills = () => listSkills(dir, own)
      superego.agent(defineExtension({ name: 'skills', sections: [section('skills', async () => skillsPrompt(await skills()))] }))
      // Named skills go after the message's own content, in the order it names them.
      superego.beforeSend(async ({ text, content }) => {
        if (!/[$/]/.test(text)) return
        const named = mentionedSkills(text, await skills())
        if (!named.length) return
        return [...content, ...await Promise.all(named.map(async (skill) => ({ type: 'text' as const, text: await skillBlock(skill) })))]
      })
      superego.method(LIST, async (): Promise<SkillInfo[]> => (await skills()).map(({ name, description }) => ({ name, description })))
      // The skills to browse, drawn by the window from data: offered for a space or beside the thread, placed by the user.
      superego.method(VIEW, async (): Promise<ViewContent> => ({
        items: (await skills()).map(({ name, description, manual }) => ({ id: name, title: `$${name}`, subtitle: description, ...(manual ? { detail: 'by name' } : {}) })),
        empty: `No skills in ${dir} yet.`,
      }))
      superego.view(VIEW, { title: 'Skills', icon: 'sparkle', context: 'window', fits: ['space', 'beside'], method: VIEW })
    },
  })
}

/** The skills in the agents' folder alone, for a daemon that brings none of its own. */
export default skillsExtension()

// skills, daemon half: the skills in the folder agents share (see skills.ts), and the app's own (its `superego` skill).
// The agent is told what each is for in a prompt section; a message that names one (`$commit`, `/skill:commit`)
// carries its instructions, through a send transform; the composer completes names from `skills.list`; and a data
// view (`skills.view`) lists them to browse.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { defineDaemonExtension, type DaemonExtension } from '@superego/daemon'
import { join } from 'node:path'
import { BLOCK_LIMITS, type Block, type ListItem } from '@superego/protocol'
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
      superego.method(LIST, async (): Promise<SkillInfo[]> => (await skills()).map(({ name, description, manual }) => ({ name, description, ...(manual ? { manual: true as const } : {}) })))
      // The skills to browse, drawn by the window from data: offered beside the thread, placed by the user.
      superego.method(VIEW, async (): Promise<Block[]> => {
        const all = await skills()
        if (!all.length) return [{ type: 'markdown', text: `No skills in ${dir} yet.` }]
        // Within what a view may hold, which the window refuses whole past it.
        const rows = all.slice(0, BLOCK_LIMITS.items).map(({ name, description, manual }): ListItem => ({
          title: `$${name}`.slice(0, BLOCK_LIMITS.text), subtitle: description.slice(0, BLOCK_LIMITS.text), ...(manual ? { detail: 'by name' } : {}),
        }))
        const more = all.length - rows.length
        return [{ type: 'list', items: rows }, ...more > 0 ? [{ type: 'markdown' as const, text: `And ${more} more.` }] : []]
      })
      superego.view(VIEW, { title: 'Skills', icon: 'sparkle', context: 'window', fits: ['beside'], method: VIEW })
    },
  })
}

/** The skills in the agents' folder alone, for a daemon that brings none of its own. */
export default skillsExtension()

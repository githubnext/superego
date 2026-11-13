// skills, daemon half: the skills in the folder agents share (see skills.ts). The agent is told what each is for in a
// prompt section; a message that names one (`$commit`, `/skill:commit`) carries its instructions, through a submit
// transform; and the composer completes names from `skills.list`.
import { defineExtension, section } from '@earendil-works/pi-durable'
import { defineDaemonExtension } from '@superego/daemon'
import { join } from 'node:path'
import { about, LIST, type SkillInfo } from './shared.ts'
import { listSkills, mentionedSkills, skillBlock, skillsPrompt } from './skills.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    const dir = join(superego.agentsDir, 'skills')
    superego.agent(defineExtension({ name: 'skills', sections: [section('skills', async () => skillsPrompt(await listSkills(dir)))] }))
    // Named skills go after the message's own content, in the order it names them.
    superego.submit(async ({ text, content }) => {
      if (!/[$/]/.test(text)) return
      const named = mentionedSkills(text, await listSkills(dir))
      if (!named.length) return
      return [...content, ...await Promise.all(named.map(async (skill) => ({ type: 'text' as const, text: await skillBlock(skill) })))]
    })
    superego.method(LIST, async (): Promise<SkillInfo[]> => (await listSkills(dir)).map(({ name, description }) => ({ name, description })))
  },
})

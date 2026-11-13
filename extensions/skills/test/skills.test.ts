import { describe, expect, it } from 'vitest'
import { frontMatter, mentionedSkills, type Skill } from '../src/skills.ts'

const skill = (name: string): Skill => ({ name, description: '', path: `/s/${name}/SKILL.md`, manual: false })

describe('skills', () => {
  it('reads front matter: plain, quoted and folded values, and the body after it', () => {
    const { data, body } = frontMatter('---\nname: a\ndescription: >-\n  one\n  two\nhint: "x: y"\n---\n\nBody\n')
    expect(data).toEqual({ name: 'a', description: 'one two', hint: 'x: y' })
    expect(body).toBe('\nBody\n')
    expect(frontMatter('no front matter').body).toBe('no front matter')
  })
  it('finds skills a message names, once each, leaving other $words alone', () => {
    const skills = [skill('commit'), skill('pr')]
    expect(mentionedSkills('$commit then /skill:pr, $commit again. $HOME costs $5 a$pr', skills).map((s) => s.name)).toEqual(['commit', 'pr'])
    expect(mentionedSkills('end with $pr.', skills).map((s) => s.name)).toEqual(['pr'])
    expect(mentionedSkills('/commit is a path-like word', skills)).toEqual([])
  })
})

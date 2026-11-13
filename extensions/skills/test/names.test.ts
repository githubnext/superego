import { describe, expect, it } from 'vitest'
import { matchSkills, sentSkills, skillAt } from '../src/names.ts'

describe('naming a skill', () => {
  it('finds $name and /skill:name at the start of a word, and /name only opening the message', () => {
    expect(skillAt('use $com', 8)).toEqual({ start: 4, trigger: '$', query: 'com' })
    expect(skillAt('$', 1)).toEqual({ start: 0, trigger: '$', query: '' })
    expect(skillAt('(/skill:co', 10)).toEqual({ start: 1, trigger: '/skill:', query: 'co' })
    expect(skillAt('/co', 3)).toEqual({ start: 0, trigger: '/', query: 'co' })
    expect(skillAt('see /tmp', 8)).toBeUndefined()
    expect(skillAt('a$b', 3)).toBeUndefined()
    // In the middle of a word: the caret is not at its end.
    expect(skillAt('$commit', 3)).toBeUndefined()
    expect(skillAt('$co later', 3)).toEqual({ start: 0, trigger: '$', query: 'co' })
  })
  it('offers names holding what was typed, those starting with it first', () => {
    const skills = [{ name: 'recommit', description: '' }, { name: 'commit', description: '' }, { name: 'pr', description: '' }]
    expect(matchSkills(skills, 'comm').map((s) => s.name)).toEqual(['commit', 'recommit'])
    expect(matchSkills(skills, '')).toHaveLength(3)
  })
})

describe('skills sent with a message', () => {
  it('finds the skill blocks the daemon added, by name and path, and only those', () => {
    const blocks = [
      { type: 'text', text: 'do $commit' },
      { type: 'text', text: '<skill name="commit" location="/s/commit/SKILL.md">\nThe user asked…\n</skill>' },
      { type: 'image', data: 'x' },
      { type: 'text', text: '<skill name="a&#38;b" location="/s/a/SKILL.md">\n…\n</skill>' },
    ]
    expect(sentSkills(blocks)).toEqual({ items: [{ name: 'commit', path: '/s/commit/SKILL.md' }, { name: 'a&b', path: '/s/a/SKILL.md' }], blocks: [1, 3] })
    expect(sentSkills([{ type: 'text', text: 'no skills' }])).toEqual({ items: [], blocks: [] })
  })
})

// The skill as it ships (out/skill): every page's links reach a page or file beside it, never Superego's repository,
// which an installed app doesn't have and whose GitHub home is private.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { expect, it } from 'vitest'
import { SKILL_DIR, skill, skillTopics } from '../src/skill.ts'

const pages = readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md'))

it('links only to what ships with it', () => {
  const broken: string[] = []
  for (const page of pages) {
    const text = readFileSync(join(SKILL_DIR, page), 'utf8')
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]!)
    for (const target of targets) {
      if (target.startsWith('#')) continue
      if (/^[a-z][\w+.-]*:/i.test(target)) {                // a web page, or a scheme of the app's own (thread:)
        if (target.includes('github.com/mikker/superego')) broken.push(`${page}: ${target}`)
        continue
      }
      const path = normalize(join(SKILL_DIR, target.replace(/#.*$/, '')))
      if (!path.startsWith(SKILL_DIR) || !existsSync(path)) broken.push(`${page}: ${target}`)
    }
  }
  expect(broken).toEqual([])
})

it('offers the guide as a topic, its examples beside it', () => {
  expect(skillTopics()).toContain('guide')
  expect(skill('guide')).toMatch(/^# Writing extensions\n/)
  expect(existsSync(join(SKILL_DIR, 'examples', 'build-queue', 'profile.ts'))).toBe(true)
})

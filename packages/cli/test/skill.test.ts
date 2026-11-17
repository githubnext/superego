// The skill as it ships (out/skill): every page's links reach a page or file beside it, never Superego's repository,
// which an installed app doesn't have and whose GitHub home is private.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, relative } from 'node:path'
import { expect, it } from 'vitest'
import { SKILL_DIR, skill, skillTopics } from '../src/skill.ts'

const pages = readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md'))

/** A page's headings as their links name them (`## A thread's life` is `#a-threads-life`), outside code blocks. */
function anchorsOf(text: string): Set<string> {
  const headings = text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#+ (.*)$/gm)
  return new Set([...headings].map((m) => m[1]!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')))
}

it('links only to what ships with it, and to headings there are', () => {
  const broken: string[] = []
  for (const page of pages) {
    const text = readFileSync(join(SKILL_DIR, page), 'utf8')
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]!)
    for (const target of targets) {
      if (/^[a-z][\w+.-]*:/i.test(target)) {                // a web page, or a scheme of the app's own (thread:)
        if (target.includes('github.com/githubnext/superego')) broken.push(`${page}: ${target}`)
        continue
      }
      const [file, anchor] = target.split('#') as [string, string | undefined]
      const path = normalize(join(SKILL_DIR, file || page))
      if (!path.startsWith(SKILL_DIR) || !existsSync(path)) broken.push(`${page}: ${target}`)
      else if (anchor && (!path.endsWith('.md') || !anchorsOf(readFileSync(path, 'utf8')).has(anchor))) broken.push(`${page}: ${target}`)
    }
  }
  expect(broken).toEqual([])
})

// An agent's read of a file stops at 50KB, and a bash result too: a page past that is read cut off, its end never seen.
it('keeps every page and example short enough to read whole', () => {
  const LIMIT = 40_000
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.(md|ts|tsx|json)$/.test(entry.name) ? [join(dir, entry.name)] : [])
  const long = files(SKILL_DIR).map((path) => ({ path: relative(SKILL_DIR, path), bytes: statSync(path).size })).filter((f) => f.bytes > LIMIT)
  expect(long, `split these into topics under ${LIMIT} bytes`).toEqual([])
})

it('offers the guide as a topic, its examples beside it', () => {
  expect(skillTopics()).toContain('guide')
  expect(skill('guide')).toMatch(/^# Writing extensions\n/)
  expect(existsSync(join(SKILL_DIR, 'examples', 'build-queue', 'profile.ts'))).toBe(true)
})

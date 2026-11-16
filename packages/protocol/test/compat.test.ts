// The aliases on the wire go at their milestones, and with their generation.
import { describe, expect, it } from 'vitest'
import { ALIASES, FEATURES, PROTOCOL_VERSION, RELEASED, type Alias } from '../src/index.ts'

describe('the aliases', () => {
  const aliases: [string, Alias][] = Object.entries(ALIASES)
  const today = new Date().toISOString().slice(0, 10)
  it('keeps no wire alias past its milestone: take it out, and the code that keeps it', () => {
    for (const [id, alias] of aliases) {
      expect(alias.until, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(alias.since <= alias.until, id).toBe(true)
      expect(today <= alias.until, `${id} was to go by ${alias.until} (${alias.note})`).toBe(true)
    }
  })
  it("doesn't count an alias as released: an old name goes at its milestone", () => {
    for (const [, alias] of aliases) if ('old' in alias) expect(RELEASED.methods as readonly string[]).not.toContain(alias.old)
    expect(RELEASED.generation).toBe(PROTOCOL_VERSION)
    for (const feature of RELEASED.features) expect(FEATURES as readonly string[]).toContain(feature)
  })
})

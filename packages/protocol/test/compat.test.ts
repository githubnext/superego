// The compatibility tables: aliases on the wire go at their milestones, and data migrations are kept apart from them.
import { describe, expect, it } from 'vitest'
import { ALIASES, MIGRATIONS, PROTOCOL_VERSION } from '../src/index.ts'

describe('the compatibility tables', () => {
  const today = new Date().toISOString().slice(0, 10)
  it('keeps no wire alias past its milestone: take it out, and the code that keeps it', () => {
    for (const [id, alias] of Object.entries(ALIASES)) {
      expect(alias.until, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(alias.since <= alias.until, id).toBe(true)
      expect(today <= alias.until, `${id} was to go by ${alias.until} (${alias.note})`).toBe(true)
    }
  })
  it('keeps no wire alias into a new protocol generation', () => {
    if (PROTOCOL_VERSION > 1) expect(Object.keys(ALIASES), 'generation 2 starts with no aliases').toEqual([])
  })
  it("keeps data migrations apart: they're for data from before a date, not tied to the protocol", () => {
    for (const [id, migration] of Object.entries(MIGRATIONS)) {
      expect(migration.before, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(migration, id).not.toHaveProperty('until')
      expect(Object.keys(ALIASES), id).not.toContain(id)
    }
  })
})

import { expect, it } from 'vitest'
import type { ThreadInfo } from '@superego/protocol'
import { matchFolders, recentFolders } from '../src/renderer/folder-field.tsx'

const thread = (root: string, activeAt: number) => ({ project: { root }, activeAt, createdAt: 0 }) as unknown as ThreadInfo

it("lists each project once, by its threads' latest activity", () => {
  expect(recentFolders([thread('/a', 1), thread('/b', 5), thread('/a', 9), thread('/c', 3)])).toEqual(['/a', '/b', '/c'])
})

it('matches by the folder’s name first, then its path, the most recent first among equals', () => {
  const folders = ['/Users/me/dev/superego', '/Users/me/dev/ledger', '/Users/me/notes/dev-log', '/srv/super']
  expect(matchFolders(folders, '')).toEqual(folders)
  expect(matchFolders(folders, 'sup')).toEqual(['/Users/me/dev/superego', '/srv/super'])
  expect(matchFolders(folders, 'dev')).toEqual(['/Users/me/notes/dev-log', '/Users/me/dev/superego', '/Users/me/dev/ledger'])
  expect(matchFolders(folders, '~/dev/l')).toEqual(['/Users/me/dev/ledger'])
  expect(matchFolders(folders, 'nothing')).toEqual([])
})

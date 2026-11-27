// @vitest-environment happy-dom
// github in a window over a real daemon and a fake gh: what happened to a pull request, a notice in its thread (a glyph
// and a headline, its "Fix it" asking the agent); and Watch… from the title bar's chip, its bell on the chip after.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '@superego/sdk/testing'
import { githubExtension } from '../src/daemon.ts'
import github from '../src/ui.tsx'
import { ATTACH, type GithubFacts } from '../src/shared.ts'
import { failedCheck, fakeGh, prNode } from './fake-gh.ts'

const URL = 'https://github.com/acme/app/pull/7'
const FAST = { tick: 50, fast: 100, slow: 100, settle: 50, backoff: 400, maxBackoff: 400, recheck: 200 }
const $ = (selector: string) => document.querySelector<HTMLElement>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

let dir: string
let daemon: TestDaemon | undefined
let ui: TestWindow | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'superego-github-window-')) })
afterEach(async () => { await ui?.unmount(); ui = undefined; await daemon?.close(); daemon = undefined; await rm(dir, { recursive: true, force: true }) })

const world = (...checks: unknown[]) => ({ login: 'octocat', prs: { 'acme/app#7': prNode('acme', 'app', 7, {
  title: 'Mentions', commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] },
}) } })
const running = { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', startedAt: '2026-01-01T10:00:00Z' }

it('draws a notice of failed checks, its Fix it asking the agent; Watch… from the chip', async () => {
  const gh = await fakeGh(dir, world(running))
  daemon = await testDaemon({ model: 'echo', extensions: [githubExtension({ env: gh.env, intervals: FAST })] })
  const thread = await daemon.thread('hello', { title: 'Mentions' })
  await daemon.dispatch(ATTACH, { thread: thread.id, url: URL })
  await daemon.until(async () => ((await daemon!.facts(thread)).github as GithubFacts | undefined)?.prs[0]?.checks === 'pending', 'checks running', 10_000)
  ui = await mountUi({ window: true, extensions: [github], machines: [daemon], select: { thread: thread.id } })
  await ui.until(() => Boolean($('.github-chip')), 'the chip')

  await gh.set(world(failedCheck('acme', 'app', 'lint', 42)))
  await ui.until(() => Boolean($('.notice .github-notice')), 'the notice', 10_000)
  const card = $('.notice')!
  expect(card.querySelector('.msg__by')!.textContent).toBe('GitHub')
  expect(card.querySelector('.github-notice__head')!.textContent).toBe('1 check failing on #7')
  expect(card.querySelector('.github-notice__detail')!.textContent).toBe('lint')
  expect(card.querySelector('.github-check.is-fail')).not.toBeNull()
  expect([...card.querySelectorAll('.notice__actions button')].map((b) => b.textContent)).toEqual(['Fix it', 'Show'])
  await ui.window!.click('Fix it')
  await ui.until(() => $$('.msg__text').some((m) => m.textContent?.includes('echo: Checks failed on acme/app#7')), 'the agent asked')

  // Watch…: both, saved; the chip rings its bell, and the menu says what it's watching.
  await ui.window!.click('.header__chip--menu')
  await ui.until(() => $$('.superego-menu__item').some((i) => i.textContent === 'Watch…'), 'its menu')
  await ui.window!.click('Watch…')
  await ui.until(() => Boolean($('.github-watch')), 'the Watch dialog')
  await ui.window!.click('.github-watch [aria-label="When it\'s reviewed"]')
  await ui.until(() => $('.github-watch [aria-label="When it\'s reviewed"]')?.getAttribute('aria-checked') === 'false', 'reviews off')
  await ui.window!.click('Watch')
  await ui.until(() => Boolean($('.github-chip__watch')), 'the bell on the chip')
  expect(((await daemon.facts(thread)).github as GithubFacts).prs[0]!.watch).toEqual({ reviews: false })
  await ui.window!.click('.header__chip--menu')
  await ui.until(() => $$('.superego-menu__item').some((i) => i.textContent === 'Watching checks…'), 'its menu, watching')
})

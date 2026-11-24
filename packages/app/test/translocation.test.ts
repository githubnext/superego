// macOS App Translocation: told apart from an app installed where the user likes it, and the move to Applications
// offered at launch: moved (the app quits for the moved copy), a copy already there, a move that fails, and a no.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTranslocated, moveToApplications, offerMove, type MoveIO } from '../src/main/translocation.ts'

const bundle = (app: string) => ({ execPath: `${app}/Contents/MacOS/Superego`, dir: `${app}/Contents/Resources/app.asar/out/main` })

describe('isTranslocated', () => {
  it('is a packaged app macOS runs from AppTranslocation', () => {
    const app = '/private/var/folders/xy/abc123/T/AppTranslocation/0F1E2D3C-4B5A/d/Superego.app'
    expect(isTranslocated({ platform: 'darwin', ...bundle(app) })).toBe(true)
  })

  it('is not an app in /Applications, ~/Applications, or a folder of the user\'s own', () => {
    for (const app of ['/Applications/Superego.app', '/Users/me/Applications/Superego.app', '/Users/me/Downloads/Superego.app', '/Users/me/Apps/Superego.app']) {
      expect(isTranslocated({ platform: 'darwin', ...bundle(app) })).toBe(false)
    }
  })

  it('is not a dev build, whose main process is no app.asar', () => {
    const execPath = '/private/var/folders/xy/T/AppTranslocation/1/d/Electron.app/Contents/MacOS/Electron'
    expect(isTranslocated({ platform: 'darwin', execPath, dir: '/Users/me/dev/superego/app/out/main' })).toBe(false)
  })

  it('is never on Linux or Windows', () => {
    const app = '/tmp/AppTranslocation/1/d/Superego.app'
    expect(isTranslocated({ platform: 'linux', ...bundle(app) })).toBe(false)
    expect(isTranslocated({ platform: 'win32', ...bundle(app) })).toBe(false)
  })
})

const WORDING = { message: 'Move Superego to Applications?', detail: 'It runs from a temporary folder.' }

function mover(overrides: Partial<MoveIO> = {}) {
  const io: MoveIO = {
    ask: vi.fn(async () => true),
    move: vi.fn(() => true),
    replace: vi.fn(() => true),
    failed: vi.fn(async () => {}),
    ...overrides,
  }
  return io
}

afterEach(() => { vi.restoreAllMocks() })

describe('offerMove', () => {
  it('moves when the user says so, and the app stops starting', async () => {
    const io = mover()
    expect(await offerMove(io, WORDING)).toBe(true)
    expect(io.ask).toHaveBeenCalledWith(WORDING)
    expect(io.move).toHaveBeenCalledOnce()
  })

  it('launches as it is when the user says not now', async () => {
    const io = mover({ ask: vi.fn(async () => false) })
    expect(await offerMove(io, WORDING)).toBe(false)
    expect(io.move).not.toHaveBeenCalled()
  })

  it('asks before replacing a copy already in Applications, and goes on as it is if told not to', async () => {
    const io = mover({ replace: vi.fn(() => false), move: vi.fn((conflict) => conflict('exists')) })
    expect(await offerMove(io, WORDING)).toBe(false)
    expect(io.replace).toHaveBeenCalledOnce()
    const yes = mover({ move: vi.fn((conflict) => conflict('exists')) })
    expect(await offerMove(yes, WORDING)).toBe(true)
  })

  it('hands over to a copy running from Applications without asking', async () => {
    const io = mover({ move: vi.fn((conflict) => conflict('existsAndRunning')) })
    expect(await offerMove(io, WORDING)).toBe(true)
    expect(io.replace).not.toHaveBeenCalled()
  })

  it('logs and tells of a move that fails, and launches as it is', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const io = mover({ move: vi.fn(() => { throw new Error('Read-only file system') }) })
    expect(await offerMove(io, WORDING)).toBe(false)
    expect(io.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'Read-only file system' }))
    expect(logged).toHaveBeenCalledWith('Moving the app to Applications:', expect.any(Error))
  })
})

describe('moveToApplications', () => {
  it('moves without asking first (Settings → About)', async () => {
    const io = mover()
    expect(await moveToApplications(io)).toBe(true)
    expect(io.ask).not.toHaveBeenCalled()
  })
})

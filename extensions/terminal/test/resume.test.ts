// OSC 7577 as a terminal's output carries it: the spec's own examples (its token and macs), every invalid report it
// lists and the rest of its rules, ignored (no effect) apart from rejected (its owner's record goes); records kept while
// their owners run, an ancestor's before a descendant's; and a command shown to the user escaped.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GRACE, ProgramResume, readReport, shown, type Processes } from '../src/resume.ts'

const TOKEN = 'dummy-token-replace-me'
const T = 1795543200
const ROOT = 100
const b64 = (text: string) => Buffer.from(text).toString('base64')
const mac = (prefix: string, token = TOKEN) => createHash('sha256').update(`${prefix}:${token}`).digest('hex')
const signed = (prefix: string) => `${prefix}:mac=${mac(prefix)}`
const osc = (body: string, end = '\x1b\\') => `\x1b]7577;${body}${end}`

const NVIM = 'pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b'
const NVIM_CLEAR = 'pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93'
const LAZYGIT = 'pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1'
const WRAP = 'pid=90412:time=1795543200:argv=cmVzdW1lLXdyYXA=,c3No,ZGV2Ym94:mac=e76149d0ba54a83570ffab0583867dacdfa23928ba9d18604f0badea88b62b65'

/** A machine where every pid runs, a child of the terminal's first process, unless it's `gone` or has `parents` of its own. */
function machine({ gone = new Set<number>(), parents = new Map<number, number>(), cwd }: { gone?: Set<number>; parents?: Map<number, number>; cwd?: string } = {}): Processes {
  return {
    info: (pid) => gone.has(pid) ? undefined : { ppid: parents.get(pid) ?? ROOT, start: 'then' },
    cwd: () => cwd,
  }
}

function terminal(options: { processes?: Processes; now?: () => number } = {}) {
  return new ProgramResume({ token: TOKEN, root: ROOT, processes: options.processes ?? machine(), now: options.now ?? (() => T * 1000) })
}

describe("the spec's examples", () => {
  it('accepts Neovim reporting its session, and its clear removes it', () => {
    expect(readReport(NVIM, TOKEN, T)).toEqual({ outcome: 'accepted', pid: 74877, time: T, argv: ['nvim', '-S', '/home/user/.local/state/nvim/sessions/8f2c1d.vim'] })
    expect(readReport(NVIM_CLEAR, TOKEN, T)).toEqual({ outcome: 'cleared', pid: 74877, time: T })
    const resume = terminal()
    expect(resume.read(osc(NVIM))).toBe(true)
    expect(resume.resume()).toEqual({ argv: ['nvim', '-S', '/home/user/.local/state/nvim/sessions/8f2c1d.vim'] })
    expect(resume.read(osc(NVIM_CLEAR, '\x07'))).toBe(true)
    expect(resume.resume()).toBeUndefined()
  })

  it('accepts lazygit with the folder to resume it in', () => {
    expect(readReport(LAZYGIT, TOKEN, T)).toEqual({ outcome: 'accepted', pid: 74877, time: T, argv: ['lazygit'], cwd: '/home/user/src/project' })
  })

  it('accepts resume-wrap ssh devbox', () => {
    expect(readReport(WRAP, TOKEN, T)).toEqual({ outcome: 'accepted', pid: 90412, time: T, argv: ['resume-wrap', 'ssh', 'devbox'] })
  })

  it('ignores them with another token, or an hour later', () => {
    expect(readReport(NVIM, 'another-token-another-one', T).outcome).toBe('ignored')
    expect(readReport(NVIM, TOKEN, T + 3600).outcome).toBe('ignored')
  })
})

describe("the spec's invalid reports", () => {
  const NOW = T
  const at = (prefix: string) => readReport(signed(prefix), TOKEN, NOW).outcome
  it.each([
    ['a mac that does not match', `pid=74877:time=${NOW}:argv=bnZpbQ==:mac=${'0'.repeat(64)}`],
    ['no mac', `pid=74877:time=${NOW}:argv=bnZpbQ==`],
    ['a mac not last', `mac=${mac(`pid=74877:time=${NOW}:argv=bnZpbQ==`)}:pid=74877:time=${NOW}:argv=bnZpbQ==`],
    ['a mac in capitals', `pid=74877:time=${NOW}:argv=bnZpbQ==:mac=${mac(`pid=74877:time=${NOW}:argv=bnZpbQ==`).toUpperCase()}`],
    ['a time too far from now', signed('pid=74877:time=1000000000:argv=bnZpbQ==')],
    ['a time in the future', signed(`pid=74877:time=${NOW + 61}:argv=bnZpbQ==`)],
    ['a time too large', signed('pid=74877:time=99999999999999999999:argv=bnZpbQ==')],
    ['no time', signed('pid=74877:argv=bnZpbQ==')],
    ['a time twice', signed(`pid=74877:time=${NOW}:time=${NOW}:argv=bnZpbQ==`)],
    ['no pid', signed(`time=${NOW}:argv=bnZpbQ==`)],
    ['a pid too large', signed(`pid=4294967296:time=${NOW}:argv=bnZpbQ==`)],
    ['a pid of 0', signed(`pid=0:time=${NOW}:argv=bnZpbQ==`)],
    ['the reserved ?', '?'],
  ])('ignores one with %s', (_, body) => {
    expect(readReport(body, TOKEN, NOW).outcome).toBe('ignored')
  })

  it.each([
    ['a relative program (./run.sh)', `pid=74877:time=${NOW}:argv=${b64('./run.sh')}`],
    ['a program in a relative folder', `pid=74877:time=${NOW}:argv=${b64('bin/run')}`],
    ['an empty program', `pid=74877:time=${NOW}:argv=,${b64('x')}`],
    ['no argv at all', `pid=74877:time=${NOW}:argv=`],
    ['a program starting with -', `pid=74877:time=${NOW}:argv=${b64('-rf')}`],
    ['both argv and clear', `pid=74877:time=${NOW}:argv=bnZpbQ==:clear=1`],
    ['neither argv nor clear', `pid=74877:time=${NOW}`],
    ['clear other than 1', `pid=74877:time=${NOW}:clear=yes`],
    ['a relative cwd', `pid=74877:time=${NOW}:argv=bnZpbQ==:cwd=cHJvamVjdA==`],
    ['an empty cwd', `pid=74877:time=${NOW}:argv=bnZpbQ==:cwd=`],
    ['need of a key it does not implement', `pid=74877:time=${NOW}:argv=bnZpbQ==:need=later`],
    ['a key twice', `pid=74877:time=${NOW}:argv=bnZpbQ==:argv=bnZpbQ==`],
    ['a malformed pair', `pid=74877:time=${NOW}:argv=bnZpbQ==:oops`],
    ['a key in capitals', `pid=74877:time=${NOW}:argv=bnZpbQ==:Extra=1`],
    ['a value out of its characters', `pid=74877:time=${NOW}:argv=bnZpbQ==:extra=a;b`],
    ['a newline in an argument', `pid=74877:time=${NOW}:argv=bnZpbQ==,${b64('a\nb')}`],
    ['a C1 control in an argument', `pid=74877:time=${NOW}:argv=bnZpbQ==,${b64('a\u009bb')}`],
    ['DEL in the cwd', `pid=74877:time=${NOW}:argv=bnZpbQ==:cwd=${b64('/tmp/\u007f')}`],
    ['bytes that are not UTF-8', `pid=74877:time=${NOW}:argv=bnZpbQ==,${Buffer.from([0xff, 0xfe]).toString('base64')}`],
    ['base64 of the other alphabet', `pid=74877:time=${NOW}:argv=bnZpbQ==,${Buffer.from([0xfb, 0xff]).toString('base64url')}`],
    ['wrong padding', `pid=74877:time=${NOW}:argv=bnZpbQ=`],
    ['padding mid-way', `pid=74877:time=${NOW}:argv=bn==ZpbQ==`],
    ['a dangling character', `pid=74877:time=${NOW}:argv=bnZpb`],
    ['bits past the last byte', `pid=74877:time=${NOW}:argv=bnZpbR==`],
    ['more arguments than it holds', `pid=74877:time=${NOW}:argv=bnZpbQ==${',eA=='.repeat(256)}`],
    ['a second mac', `pid=74877:time=${NOW}:argv=bnZpbQ==:mac=${'0'.repeat(64)}`],
  ])('rejects one with %s', (_, prefix) => {
    expect(at(prefix)).toBe('rejected')
  })

  it('takes padding as optional, empty arguments after the first, unknown keys, and need of keys it knows', () => {
    expect(readReport(signed(`pid=74877:time=${NOW}:argv=bnZpbQ,,LVM,${b64('a b')}:later=x:need=argv,cwd`), TOKEN, NOW))
      .toEqual({ outcome: 'accepted', pid: 74877, time: NOW, argv: ['nvim', '', '-S', 'a b'] })
    expect(readReport(signed(`pid=74877:time=${NOW}:argv=${b64('/usr/bin/vim')},${b64('$(reboot); a; b ‮')}`), TOKEN, NOW))
      .toMatchObject({ outcome: 'accepted', argv: ['/usr/bin/vim', '$(reboot); a; b \u202e'] })
    expect(readReport(signed(`pid=74877:time=${NOW}:argv=bnZpbQ==${',eA=='.repeat(255)}`), TOKEN, NOW).outcome).toBe('accepted')
  })
})

describe('records', () => {
  const report = (prefix: string, end?: string) => osc(signed(prefix), end)
  const nvim = (pid = 74877, time = T, extra = '') => report(`pid=${pid}:time=${time}:argv=bnZpbQ==${extra}`)

  it('reads reports split anywhere, after other output, by either terminator', () => {
    const resume = terminal()
    const text = `hello\x1b]7501;state=working\x07${report(`pid=5:time=${T}:argv=${b64('lazygit')}`, '\x07')}more`
    let changed = false
    for (let at = 0; at < text.length; at += 1) changed = resume.read(text.slice(at, at + 1)) || changed
    expect(changed).toBe(true)
    expect(resume.resume()).toEqual({ argv: ['lazygit'] })
  })

  it('keeps its record through what a report fails the mac or time of, and drops it for one rejected', () => {
    const resume = terminal()
    resume.read(nvim())
    const kept = resume.resume()
    expect(kept).toEqual({ argv: ['nvim'] })
    // Ignored: another token, a stale time, one earlier than the last accepted, the reserved ?, cut short.
    expect(resume.read(osc(`pid=74877:time=${T}:clear=1:mac=${mac(`pid=74877:time=${T}:clear=1`, 'someone-elses-token-0000')}`))).toBe(false)
    expect(resume.read(report(`pid=74877:time=${T - 120}:clear=1`))).toBe(false)
    expect(resume.read(report(`pid=74877:time=${T - 1}:clear=1`))).toBe(false)
    expect(resume.read(osc('?'))).toBe(false)
    expect(resume.read(`\x1b]7577;${signed(`pid=74877:time=${T}:clear=1`).slice(0, -1)}\x1b]7577;x\x07`)).toBe(false)
    expect(resume.resume()).toEqual(kept)
    // Rejected: a relative program.
    expect(resume.read(report(`pid=74877:time=${T}:argv=${b64('./run.sh')}`))).toBe(true)
    expect(resume.resume()).toBeUndefined()
  })

  it('takes a report up to 8192 bytes long, and ignores a longer one, whole or in pieces', () => {
    const long = (n: number) => report(`pid=7:time=${T}:argv=bnZpbQ==:pad=${'x'.repeat(n)}`)
    const fits = long(8192 - long(0).length)
    expect(fits.length).toBe(8192)
    expect(terminal().read(fits)).toBe(true)
    const over = long(8193 - long(0).length)
    expect(terminal().read(over)).toBe(false)
    const resume = terminal()
    for (let at = 0; at < over.length; at += 1000) resume.read(over.slice(at, at + 1000))
    expect(resume.resume()).toBeUndefined()
  })

  it('takes only reports for processes running in the terminal', () => {
    expect(terminal({ processes: machine({ gone: new Set([74877]) }) }).read(nvim())).toBe(false)
    // Its parent isn't the terminal's first process, nor any of its descendants.
    expect(terminal({ processes: machine({ parents: new Map([[74877, 1]]) }) }).read(nvim())).toBe(false)
    // Its first process: brought back as that.
    const first = terminal()
    first.read(nvim(ROOT))
    expect(first.resume()).toEqual({ argv: ['nvim'], first: true })
  })

  it("prefers an ancestor's record to its descendant's, else the latest", () => {
    const parents = new Map([[300, 200]])
    const resume = terminal({ processes: machine({ parents }) })
    resume.read(report(`pid=200:time=${T}:argv=${b64('outer')}`))
    resume.read(report(`pid=300:time=${T}:argv=${b64('inner')}`))
    expect(resume.resume()?.argv).toEqual(['outer'])
    resume.read(report(`pid=400:time=${T}:argv=${b64('sibling')}`))
    expect(resume.resume()?.argv).toEqual(['sibling'])
    resume.read(report(`pid=400:time=${T}:clear=1`))
    expect(resume.resume()?.argv).toEqual(['outer'])
  })

  it('keeps where its owner was, when it said nowhere', () => {
    const resume = terminal({ processes: machine({ cwd: '/home/user/src' }) })
    resume.read(nvim())
    expect(resume.resume()).toEqual({ argv: ['nvim'], dir: '/home/user/src' })
    resume.read(report(`pid=74877:time=${T}:argv=bnZpbQ==:cwd=${b64('/srv')}`))
    expect(resume.resume()).toEqual({ argv: ['nvim'], cwd: '/srv' })
  })

  it('drops a record once its owner has been gone a while, not at once', () => {
    let now = T * 1000
    const gone = new Set<number>()
    const resume = terminal({ processes: machine({ gone }), now: () => now })
    resume.read(nvim())
    gone.add(74877)
    expect(resume.sweep()).toBe(false)
    now += GRACE
    expect(resume.sweep()).toBe(false)
    expect(resume.resume()).toEqual({ argv: ['nvim'] })
    now += 1
    expect(resume.sweep()).toBe(true)
    expect(resume.resume()).toBeUndefined()
    expect(resume.holding).toBe(false)
  })
})

it('shows a command escaped: quoted where it needs it, and nothing that could mislead', () => {
  expect(shown(['nvim', '-S', '/home/user/s.vim'])).toBe('nvim -S /home/user/s.vim')
  expect(shown(['echo', "it's", '$(x) y', ''])).toBe(`echo 'it\\'s' '$(x) y' ''`)
  expect(shown(['cat', 'evil\u202etxt.exe', 'a\u200bb', 'tab\u00a0x'])).toBe("cat 'evil\\u{202e}txt.exe' 'a\\u{200b}b' 'tab\\u{a0}x'")
})

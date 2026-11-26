// How a terminal starts a command (a program a window asked for, or one being resumed: OSC 7577) in the user's shell,
// after its startup files, without ever reading the command as shell: its words reach the program as they were given,
// `$(reboot)` and `a; b` as text. They go to the shell as data, its arguments or a file it reads once and removes, and
// run through `env`, so it's the program on PATH that runs, never an alias, function or builtin (`eval` would read the
// rest as shell).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export type Shell = { file: string; args: string[] }
/** The shells a resumed program can be the first job of: each starts it its own way. */
type Kind = 'zsh' | 'bash' | 'fish' | 'sh'

const ENV = existsSync('/usr/bin/env') ? '/usr/bin/env' : '/bin/env'

/** The kind of shell `file` is, if it's one a program can be resumed in as its job. */
export function shellKind(file: string): Kind | undefined {
  const name = basename(file).replace(/^-/, '')
  if (name === 'zsh' || name === 'bash' || name === 'fish') return name
  if (/^(sh|dash|ash|ksh|mksh|oksh|pdksh|yash|posh)$/.test(name)) return 'sh'
  return undefined
}

/** A word as a POSIX shell reads it back: quoted. Only for this terminal's own paths, never a command's words. */
const quoted = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`
/** The same for fish. */
const fishQuoted = (word: string) => `'${word.replace(/[\\']/g, '\\$&')}'`

/**
 * The shell's arguments to run `argv` as its only process, after its startup files (login, interactive: where mise
 * and the like put programs on the PATH): it `exec`s it, so the program is the terminal's first process.
 */
export function firstProcess(shell: Shell, argv: string[]): string[] {
  return shellKind(shell.file) === 'fish'
    ? [...shell.args, '-i', '-c', `exec ${ENV} -- $argv`, ...argv]
    : [...shell.args, '-i', '-c', `exec ${ENV} -- "$@"`, shell.file, ...argv]
}

/**
 * How to start the user's shell so that `argv` is its first job: run at its first prompt, after its startup files,
 * so it can be suspended and the user is back at the prompt as it exits. Writes what the shell reads into `dir`
 * (made here, the user's only), which the shell removes as it's read. `env` is what the shell would start with;
 * `parent` the pid it's started from. Nothing for a shell it can't do this for.
 */
export function asJob(shell: Shell, argv: string[], { dir, env, parent }: { dir: string; env: Record<string, string>; parent: number }): { args: string[]; env: Record<string, string> } | undefined {
  const kind = shellKind(shell.file)
  if (!kind) return undefined
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // One word a line: the protocol allows no control characters in them, so no newlines.
  writeFileSync(join(dir, 'argv'), argv.map((word) => `${word}\n`).join(''), { mode: 0o600 })
  const write = (name: string, lines: string[]) => writeFileSync(join(dir, name), `${lines.join('\n')}\n`, { mode: 0o600 })
  const login = shell.args.some((arg) => arg === '-l' || arg === '--login')
  const header = '# Superego is resuming a program in this shell (OSC 7577): at its first prompt, after its startup files.'
  const read = (into: string) => [
    `${into}=()`,
    `while IFS= read -r __superego_line; do ${into}+=("$__superego_line"); done < ${quoted(join(dir, 'argv'))}`,
    'unset __superego_line',
  ]

  if (kind === 'zsh') {
    // zsh reads its startup files from ZDOTDIR: this folder's, each of which reads the user's own (from their ZDOTDIR,
    // as it is then: a .zshenv may set it). Ours isn't exported, so a shell a startup file starts reads its own.
    const user = env.ZDOTDIR
    write('.zshenv', [
      header,
      'typeset -g __superego_dir=$ZDOTDIR __superego_zdv __superego_zds',
      'typeset -ga __superego_resume_argv',
      ...read('__superego_resume_argv'),
      'command rm -f -- $__superego_dir/argv',
      user === undefined ? '__superego_zds=unset' : `__superego_zds=export __superego_zdv=${quoted(user)}`,
      // Theirs, as it was, for their files to read.
      '__superego_user() {',
      '  case $__superego_zds in',
      '    (unset) unset ZDOTDIR ;;',
      '    (set) typeset -g +x ZDOTDIR; ZDOTDIR=$__superego_zdv ;;',
      '    (export) export ZDOTDIR=$__superego_zdv ;;',
      '  esac',
      '}',
      // Theirs noted, as their file left it; ours again.
      '__superego_ours() {',
      '  if (( ! ${+ZDOTDIR} )); then __superego_zds=unset',
      '  elif [[ ${(t)ZDOTDIR} == *export* ]]; then __superego_zds=export __superego_zdv=$ZDOTDIR',
      '  else __superego_zds=set __superego_zdv=$ZDOTDIR; fi',
      '  typeset -g +x ZDOTDIR; ZDOTDIR=$__superego_dir',
      '}',
      '__superego_source() { __superego_user; [[ -r ${ZDOTDIR:-$HOME}/$1 ]] && builtin source ${ZDOTDIR:-$HOME}/$1; __superego_ours; }',
      // Startup done: theirs for good, and the program at the first prompt.
      '__superego_done() {',
      '  __superego_user',
      '  command rm -rf -- $__superego_dir',
      '  unset __superego_dir __superego_zdv __superego_zds',
      '  unfunction __superego_user __superego_ours __superego_source __superego_done',
      '  precmd_functions+=(__superego_resume)',
      '}',
      '__superego_resume() {',
      '  precmd_functions=(${precmd_functions:#__superego_resume})',
      '  unfunction __superego_resume',
      '  local -a __superego_argv=("${__superego_resume_argv[@]}")',
      '  unset __superego_resume_argv',
      `  command ${ENV} -- "\${__superego_argv[@]}"`,
      '}',
      '__superego_source .zshenv',
    ])
    write('.zprofile', ['__superego_source .zprofile'])
    write('.zshrc', ['__superego_source .zshrc', '[[ -o login ]] || __superego_done'])
    write('.zlogin', ['__superego_source .zlogin', '__superego_done'])
    return { args: [...shell.args, '-i'], env: { ...env, ZDOTDIR: dir } }
  }

  if (kind === 'bash') {
    // Started with this as its rcfile (so not as a login shell): it reads what a login shell would, or ~/.bashrc.
    const profile = !shell.args.includes('--noprofile')
    const rc = !shell.args.includes('--norc')
    write('rc.bash', [
      header,
      ...read('__superego_resume_argv'),
      `command rm -rf -- ${quoted(dir)}`,
      ...login
        ? profile ? [
            '[ -r /etc/profile ] && . /etc/profile',
            'if [ -r ~/.bash_profile ]; then . ~/.bash_profile; elif [ -r ~/.bash_login ]; then . ~/.bash_login; elif [ -r ~/.profile ]; then . ~/.profile; fi',
          ] : []
        : rc ? ['[ -r ~/.bashrc ] && . ~/.bashrc'] : [],
      '__superego_resume() {',
      '  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then',
      '    local __superego_pc=() __superego_c',
      '    for __superego_c in "${PROMPT_COMMAND[@]}"; do [[ $__superego_c == __superego_resume ]] || __superego_pc+=("$__superego_c"); done',
      '    PROMPT_COMMAND=("${__superego_pc[@]}")',
      "  else PROMPT_COMMAND=${PROMPT_COMMAND%$'\\n'__superego_resume}; PROMPT_COMMAND=${PROMPT_COMMAND#__superego_resume}; fi",
      '  unset -f __superego_resume',
      '  local __superego_argv=("${__superego_resume_argv[@]}")',
      '  unset __superego_resume_argv',
      `  command ${ENV} -- "\${__superego_argv[@]}"`,
      '}',
      // Last, after what the startup files hooked to the prompt (direnv's): a list from bash 5.1, else lines.
      'if (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 501 )); then PROMPT_COMMAND+=(__superego_resume)',
      "else PROMPT_COMMAND=${PROMPT_COMMAND:+$PROMPT_COMMAND$'\\n'}__superego_resume; fi",
    ])
    const args = shell.args.filter((arg) => arg !== '-l' && arg !== '--login' && arg !== '--norc')
    return { args: [...args, '--rcfile', join(dir, 'rc.bash'), '-i'], env }
  }

  if (kind === 'fish') {
    // Run after its config (`-C`); at its first prompt, as a line the user could have typed, of fixed words: fish
    // can't suspend what an event handler runs. A line starting with a space stays out of its history.
    write('resume.fish', [
      header,
      'set -g __superego_resume_argv',
      `while read -l __superego_line; set -a __superego_resume_argv $__superego_line; end < ${fishQuoted(join(dir, 'argv'))}`,
      `command rm -rf -- ${fishQuoted(dir)}`,
      'function __superego_resume --on-event fish_prompt',
      '    functions -e __superego_resume',
      `    commandline -r ' command ${ENV} -- $__superego_resume_argv; set -e __superego_resume_argv'`,
      '    commandline -f execute',
      'end',
    ])
    return { args: [...shell.args, '-i', '-C', `source ${fishQuoted(join(dir, 'resume.fish'))}`], env }
  }

  // A POSIX shell reads $ENV last as it starts, interactive. Only this one: a shell its startup starts (a
  // multiplexer's) is another's child, and reads the user's.
  const user = env.ENV
  write('env.sh', [
    header,
    user === undefined ? 'unset ENV' : `ENV=${quoted(user)}; export ENV`,
    `if [ "$PPID" = ${parent} ]; then`,
    ...user === undefined ? [] : ['  [ -r "$ENV" ] && . "$ENV"'],
    '  set --',
    `  while IFS= read -r __superego_line; do set -- "$@" "$__superego_line"; done < ${quoted(join(dir, 'argv'))}`,
    `  command rm -rf -- ${quoted(dir)}`,
    '  unset __superego_line',
    `  command ${ENV} -- "$@"`,
    '  set --',
    ...user === undefined ? [] : ['else', '  [ -r "$ENV" ] && . "$ENV"'],
    'fi',
  ])
  return { args: [...shell.args, '-i'], env: { ...env, ENV: join(dir, 'env.sh') } }
}

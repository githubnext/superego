// `mu new <dir>`: a new app on mu, from one of the example apps. The project gets its own name, id, command,
// environment prefix and smoke test; its @mu/* dependencies link to the mu checkout this command runs from, until the
// packages are published.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { defineApp, envName, RpcError, type AppConfig } from '@mu/protocol'

export type Template = 'full' | 'minimal'

export type GenerateOptions = {
  /** The mu checkout: its `examples/` are the templates and its packages the dependencies. */
  root: string
  dir: string
  template?: Template
  name?: string
  id?: string
}

/** Where each @mu/* package lives in the checkout. */
function packages(root: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const group of ['packages', 'extensions']) {
    for (const name of readdirSync(join(root, group))) {
      const path = join(root, group, name)
      const pkg = join(path, 'package.json')
      if (existsSync(pkg)) found.set(JSON.parse(readFileSync(pkg, 'utf8')).name, path)
    }
  }
  return found
}

export function generate(options: GenerateOptions): { dir: string; app: AppConfig; template: Template } {
  const template = options.template ?? 'full'
  const source = join(options.root, 'examples', template)
  const dir = resolve(options.dir)
  if (existsSync(dir) && readdirSync(dir).length) throw new RpcError('exists', `${dir} isn't empty`)
  const id = options.id ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+|-+$/g, '')
  const app = defineApp({ name: options.name ?? basename(dir), id, glyph: (options.name ?? id).slice(0, 1).toLowerCase() })
  const old = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string; bin: Record<string, string>; dependencies: Record<string, string> }
  const oldId = old.name
  const oldPrefix = envName({ name: oldId, id: oldId }, '')
  const prefix = envName(app, '')

  mkdirSync(dir, { recursive: true })
  cpSync(source, dir, { recursive: true, filter: (path) => !/\/(node_modules|out)(\/|$)/.test(path.slice(source.length)) })

  // Identity.
  const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  writeFileSync(join(dir, 'mu.config.ts'), `import { defineApp } from '@mu/protocol'

export default defineApp({ name: ${quote(app.name)}, id: ${quote(app.id)}, glyph: ${quote(app.glyph!)} })
`)
  renameSync(join(dir, 'bin', `${oldId}.ts`), join(dir, 'bin', `${id}.ts`))
  const bin = join(dir, 'bin', `${id}.ts`)
  writeFileSync(bin, readFileSync(bin, 'utf8').replace(/`[^`]+`: [^\n]+'s command line\./, `\`${id}\`: ${app.name}'s command line.`))

  // Dependencies: link the checkout's packages.
  const found = packages(options.root)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  pkg.name = id
  pkg.bin = { [id]: `./bin/${id}.ts` }
  for (const name of Object.keys(pkg.dependencies)) {
    if (!name.startsWith('@mu/')) continue
    const path = found.get(name)
    if (!path) throw new Error(`No package ${name} in ${options.root}`)
    pkg.dependencies[name] = `link:${path}`
  }
  pkg.scripts.link = `ln -sf "$PWD/bin/${id}.ts" "$HOME/.local/bin/${id}" && echo "Linked $HOME/.local/bin/${id}"`
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  // pnpm settings come from the checkout: which packages may run install scripts, and which are trusted when new.
  const workspace = readFileSync(join(options.root, 'pnpm-workspace.yaml'), 'utf8')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace.replace(/^packages:\n(?:  - .*\n)*/m, ''))

  // A standalone TypeScript config: the checkout's base, inlined.
  const base = JSON.parse(readFileSync(join(options.root, 'tsconfig.base.json'), 'utf8'))
  const own = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { ...base.compilerOptions, ...own.compilerOptions },
    include: own.include,
  }, null, 2) + '\n')

  // The smoke test, under the new name.
  for (const file of ['test/smoke.sh', 'test/smoke.mjs']) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(oldPrefix, prefix).replaceAll(`../bin/${oldId}.ts`, `../bin/${id}.ts`).replaceAll(`smoke(${oldId === 'mu' ? 'first' : 'minimal'})`, `smoke(${oldId === 'mu' ? 'first' : 'minimal'})`))
  }

  writeFileSync(join(dir, '.gitignore'), 'node_modules\nout\n*.tsbuildinfo\n.DS_Store\n')
  writeFileSync(join(dir, 'README.md'), `# ${app.name}

An agent app on [mu](${options.root}), from its \`${template}\` example.

\`\`\`sh
pnpm install
pnpm dev            # the app, with a daemon in ~/.${id}
pnpm build && pnpm link   # \`${id}\` on your PATH: \`${id}\` starts a session here
pnpm smoke          # headless end to end
\`\`\`

- \`mu.config.ts\`: name, id, menu bar glyph
- \`src/daemon.ts\`: the daemon and its extensions (agent tools, settings, methods)
- \`src/renderer/main.tsx\`: the window and its extensions (sidebar, transcript renderers, …)
- \`bin/${id}.ts\`: the command line
`)
  return { dir, app, template }
}

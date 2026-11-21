// One declaration file per SDK entry, for an author (or their agent) to read: the entry's emitted declarations bundled
// with everything of ours they reach (rollup-plugin-dts), so nothing points into Superego's own packages. What the
// entry exports comes first, in the order its source exports it, each marked `export` where it's declared; what those
// refer to follows. Outside packages (React, pi-durable, …) stay imports: their types are installed beside it.
import type * as TS from '@typescript/typescript6'

export type FlattenOptions = {
  /** The entry's emitted declarations, in a node_modules where ours are installed as declarations too. */
  input: string
  /** What the entry exports, in its source's order. */
  order: string[]
  /** The file's opening comment: what the entry is for. */
  header: string
  /** Modules declared by hand (`declare module 'ws' { … }`), by name: their bodies, inlined as modules of ours. */
  standIns: Map<string, string>
  /** Module patterns declared without a body (`*.css`): imports of these are dropped. */
  empty: RegExp[]
  /** Whether a bare import is ours (inlined), not an outside package's. */
  ours: (id: string) => boolean
  /** Told of each outside import, and the file importing it. */
  outside?: (id: string, importer: string) => void
}

/** The flattened declarations of one entry. */
export async function flatten(options: FlattenOptions): Promise<string> {
  const { rollup } = await import('rollup')
  const { dts } = await import('rollup-plugin-dts')
  const ts = (await import('@typescript/typescript6')).default
  const standIn = '/stand-in/'
  const bundle = await rollup({
    input: options.input,
    plugins: [{
      name: 'stand-ins',
      resolveId: (id) => options.standIns.has(id) ? `${standIn}${id}.d.ts` : options.empty.some((pattern) => pattern.test(id)) ? `${standIn}empty.d.ts` : null,
      load: (id) => !id.startsWith(standIn) ? null : id === `${standIn}empty.d.ts` ? 'export {}' : options.standIns.get(id.slice(standIn.length, -'.d.ts'.length))!,
    }, dts({ respectExternal: true, compilerOptions: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler } })],
    external: (id, importer) => {
      if (/^[./\0]/.test(id) || options.ours(id) || options.standIns.has(id) || options.empty.some((pattern) => pattern.test(id))) return false
      if (importer) options.outside?.(id, importer)
      return true
    },
    onwarn: (warning) => { throw new Error(`Flattening ${options.input}: ${warning.message}`) },
  })
  const { output } = await bundle.generate({ format: 'es' })
  await bundle.close()
  return arrange(ts, output[0].code, options.order, options.header)
}

/** A top-level statement's name, if it declares one. */
function nameOf(ts: typeof import('@typescript/typescript6'), statement: TS.Statement): string | undefined {
  if (ts.isVariableStatement(statement)) {
    const [declaration, ...more] = statement.declarationList.declarations
    return declaration && !more.length && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
  }
  const name = (statement as { name?: TS.Node }).name
  return name && ts.isIdentifier(name) ? name.text : undefined
}

/**
 * Rollup's bundle laid out to be read: the header; outside imports; each export where it's declared, in `order`;
 * then the rest, as rollup had it. A declaration exported under another name takes that name when nothing else has it.
 */
export function arrange(ts: typeof import('@typescript/typescript6'), code: string, order: string[], header: string): string {
  // Paths to hand-written declarations are gone (they're inlined); `types` ones stay.
  const references = [...code.matchAll(/^\/\/\/ <reference types=.*$/gm)].map(([line]) => line)
  let source = ts.createSourceFile('bundle.d.ts', code.replace(/^\/\/\/ <reference .*\n/gm, ''), ts.ScriptTarget.Latest, true)

  // What's exported under another name than its declaration's: renamed, where the name is free.
  const declared = new Set(source.statements.map((statement) => nameOf(ts, statement)).filter((name) => name !== undefined))
  const imported = new Set(source.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    return [clause?.name?.text, ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.map((e) => e.name.text) : bindings ? [bindings.name.text] : [])]
  }))
  const renames = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      const local = element.propertyName?.text
      if (local && declared.has(local) && !declared.has(element.name.text) && !imported.has(element.name.text)) renames.set(local, element.name.text)
    }
  }
  if (renames.size) {
    const edits: { at: number; end: number; text: string }[] = []
    const visit = (node: TS.Node) => {
      // A name, not a member's, a property's or a parameter's.
      const parent = node.parent
      const member = !!parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isQualifiedName(parent) && parent.right === node)
        || ((ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent)
          || ts.isPropertyAssignment(parent) || ts.isEnumMember(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isParameter(parent)
          || ts.isTypeParameterDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node))
      if (ts.isIdentifier(node) && renames.has(node.text) && !member) {
        edits.push({ at: node.getStart(source), end: node.getEnd(), text: renames.get(node.text)! })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    let text = source.text
    for (const edit of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, edit.at) + edit.text + text.slice(edit.end)
    source = ts.createSourceFile('bundle.d.ts', text, ts.ScriptTarget.Latest, true)
  }

  const head: string[] = []
  const exports = new Map<string, { as: string; type: boolean }[]>()
  const declarations: { name?: string; statement: TS.Statement }[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.moduleSpecifier)) head.push(statement.getText(source))
    else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text
        exports.set(local, [...exports.get(local) ?? [], { as: element.name.text, type: statement.isTypeOnly || element.isTypeOnly }])
      }
    } else if (!(ts.isExportDeclaration(statement) && !statement.exportClause)) declarations.push({ name: nameOf(ts, statement), statement })
  }

  const inline = (name?: string) => name !== undefined && !!exports.get(name)?.every((e) => e.as === name)
  const marked = new Set<string>()
  // A declaration with its doc comment, marked `export` when that's the name it's exported as.
  const textOf = ({ name, statement }: { name?: string; statement: TS.Statement }) => {
    const text = source.text.slice(statement.getFullStart(), statement.getEnd()).replace(/^\s*\n/, '')
    if (!inline(name)) return text
    marked.add(name!)
    const at = text.length - (statement.getEnd() - statement.getStart(source))
    return text.slice(0, at) + 'export ' + text.slice(at)
  }

  // Exports in the entry's order (by the names they're exported as), then any it didn't name, then the rest.
  const byExport = new Map([...exports].flatMap(([local, as]) => as.map(({ as: name }) => [name, local] as const)))
  const locals = [...new Set([...order.map((name) => byExport.get(name)).filter((name) => name !== undefined), ...exports.keys()])]
  const placed = new Set<TS.Statement>()
  const take = (match: (name?: string) => boolean) => declarations.filter((d) => !placed.has(d.statement) && match(d.name)).map((d) => { placed.add(d.statement); return textOf(d) })
  const api = locals.flatMap((local) => take((name) => name === local))
  const rest = take(() => true)

  const lists = (type: boolean) => [...exports].flatMap(([local, as]) => marked.has(local) ? [] : as.filter((e) => e.type === type).map((e) => e.as === local ? local : `${local} as ${e.as}`))
  const values = lists(false)
  const types = lists(true)
  // A blank line between declarations, but for a run of one-liners with no doc (the icons, say).
  const lines = (texts: string[]) => texts.map((text, i) => i === 0 ? text : `${/\n|^\/[*/]/.test(text) || /\n|^\/[*/]/.test(texts[i - 1]!) ? '\n\n' : '\n'}${text}`).join('')
  const comment = header.trim().split('\n').map((line) => `// ${line}`.trimEnd()).join('\n')
  return [
    [comment, ...references].join('\n'),
    head.join('\n'),
    lines(api),
    ...(rest.length ? [`// What the exports above refer to.\n\n${lines(rest)}`] : []),
    [...(values.length ? [`export { ${values.join(', ')} };`] : []), ...(types.length ? [`export type { ${types.join(', ')} };`] : [])].join('\n'),
  ].filter(Boolean).join('\n\n') + '\n'
}

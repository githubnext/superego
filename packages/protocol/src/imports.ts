// What a module imports, read as JavaScript is (es-module-lexer), not by pattern: comments and strings are skipped, an
// import split by a comment is still one. One reading for the daemon (what a profile's modules load, to version and
// vouch for them: module-graph.ts) and the window (what a profile's UI loads, to fetch and point at: profile-ui.ts).
//
// Static imports, re-exports and `import()` of a literal path are read. An `import()` of a path worked out as it runs
// is refused: what it loads can't be known before it runs, so can be neither versioned nor vouched for.
// The asm.js build: synchronous, no WebAssembly to set up, the same in Node and the window.
import { parse } from 'es-module-lexer/js'
import { RpcError } from './rpc.ts'

/** One import in a module: its specifier, and where it is in the code (the specifier's text, quotes excluded). */
export type ModuleImport = { specifier: string; start: number; end: number }

/** The imports of `code` (JavaScript), in order. `where` names it in errors. Throws where it can't tell what it loads. */
export function importsOf(code: string, where: string): ModuleImport[] {
  let imports: ReturnType<typeof parse>[0]
  try {
    [imports] = parse(code, where)
  } catch (error) {
    throw new RpcError('invalid', `${where}: can't read its imports: ${(error as Error).message}`)
  }
  const found: ModuleImport[] = []
  for (const at of imports) {
    if (at.d === -2) continue // import.meta
    const dynamic = at.d > -1
    if (at.n === undefined) {
      const line = code.slice(0, at.s).split('\n').length
      throw new RpcError('invalid', `${where}:${line} imports import(${code.slice(at.s, at.e)}), a path worked out as it runs: what it loads can't be versioned or vouched for`, {
        hint: `Import a literal path: import('./module.ts')`,
      })
    }
    // A dynamic import's range takes in its quotes; a static one's doesn't.
    found.push(dynamic ? { specifier: at.n, start: at.s + 1, end: at.e - 1 } : { specifier: at.n, start: at.s, end: at.e })
  }
  return found
}

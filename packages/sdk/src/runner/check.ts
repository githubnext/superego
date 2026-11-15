// Check a profile's types as `tsc -p <its tsconfig.json>` would, with TypeScript's compiler in this Superego and its
// standard library's declarations (lib.*.d.ts) from the author types (`<types>/lib`, types.ts), so nothing need be
// installed: the rest ('superego', React, Node, vitest) comes from the profile's node_modules, linked to those types.
import { join } from 'node:path'

/** Check the project `tsconfig` names against the types at `types`; resolves to how many errors it found. */
export async function checkTypes(tsconfig: string, types: string): Promise<number> {
  const ts = (await import('typescript')).default
  const report: string[] = []
  const config = ts.getParsedCommandLineOfConfigFile(tsconfig, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { report.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
  })
  if (!config) { console.log(report.join('\n')); return 1 }
  const lib = join(types, 'lib')
  const host = ts.createCompilerHost(config.options)
  host.getDefaultLibLocation = () => lib
  host.getDefaultLibFileName = (options) => join(lib, ts.getDefaultLibFileName(options))
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, host, projectReferences: config.projectReferences })
  const diagnostics = ts.sortAndDeduplicateDiagnostics([...config.errors, ...ts.getPreEmitDiagnostics(program)])
  const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (diagnostics.length) {
    const format = process.stdout.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics
    console.log(format(diagnostics, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => join(tsconfig, '..'), getNewLine: () => '\n' }).trimEnd())
  }
  return errors.length
}

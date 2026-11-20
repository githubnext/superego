// Artifacts: HTML pages of a thread's, served sandboxed (the desktop's superego-artifact://, Web access's /artifact/),
// with the files they link to beside them.

/**
 * The file an artifact's address asks for, as a path in the thread's folder; undefined for one that leaves it.
 *
 * Unlike a file the user or the agent opens (`file.read` reads any), what an artifact is served is asked for by the page
 * itself: a script in HTML the agent wrote (from whatever it read on the web) can ask for any address beside it. So an
 * artifact gets the thread's folder, and nothing past it: no `..` out of it, no absolute or `~` path.
 */
export function artifactFile(path: string): string | undefined {
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return undefined
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.pop()) return undefined }
    else if (part && part !== '.') parts.push(part)
  }
  return parts.length ? parts.join('/') : undefined
}

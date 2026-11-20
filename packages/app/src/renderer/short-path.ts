/** A home-relative path: `/Users/me/dev/x` reads as `~/dev/x`. */
export const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

/** A thread's file as it's shown: relative to the thread's folder `cwd` when it's in it, else whole (home as `~`). */
export function filePath(cwd: string, path: string) {
  const folder = cwd.replace(/\/+$/, '')
  if (path.startsWith(`${folder}/`)) return path.slice(folder.length + 1)
  return path.startsWith('/') ? shortPath(path) : path
}

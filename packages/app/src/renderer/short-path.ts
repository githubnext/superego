/** A home-relative path: `/Users/me/dev/x` reads as `~/dev/x`. */
export const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

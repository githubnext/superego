/**
 * Look every `every` ms until `check` answers something (not undefined), and answer it; past `ms`, fail with `failure`
 * (an error, or its message).
 */
export async function waitUntil<T>(check: () => T | undefined, ms: number, failure: string | Error, every = 200): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const found = check()
    if (found !== undefined) return found
    if (Date.now() > deadline) throw typeof failure === 'string' ? new Error(failure) : failure
    await new Promise((resolve) => setTimeout(resolve, every))
  }
}

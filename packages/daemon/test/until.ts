// Waiting in tests: for something to come true, checked every 20ms, failing once `ms` pass without it.
export async function until(check: () => unknown, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

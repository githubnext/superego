// Whether work a test started is still going: for a test that stops a build, a server or a watcher, and checks that
// nothing it started outlived it.

/** Whether a process is still there, by its id: running, stopped, or exited but not yet reaped. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: there, but someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

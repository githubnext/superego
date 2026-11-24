// macOS App Translocation: a downloaded app opened where it was unzipped (Downloads, say), still quarantined, runs from
// a read-only copy macOS mounts under /private/var/folders/…/AppTranslocation/<uuid>/d/. Squirrel can't update that
// copy, a command line installed from it points at a path gone after the next reboot, and when the mount goes away
// under it (the download moved or deleted) the app's every thread faults on the missing pages and it freezes. So at
// launch the app offers to move itself to Applications, and while it stays translocated it neither updates nor
// installs its command line. The Electron wiring is app-move.ts; this is the logic alone.

/**
 * Whether this is a packaged app (`dir`, its out/main, in an app.asar: `app.isPackaged` is true of `pnpm dev`'s
 * Electron too) that macOS runs translocated. Only that: an app kept in a folder of the user's own, not quarantined,
 * runs where it is and is left be.
 */
export function isTranslocated({ platform, execPath, dir }: { platform: NodeJS.Platform; execPath: string; dir: string }): boolean {
  return platform === 'darwin' && /\.asar([/\\]|$)/.test(dir) && execPath.includes('/AppTranslocation/')
}

export type MoveIO = {
  /** At launch: ask whether to move the app to Applications. True: the user said move. */
  ask(): Promise<boolean>
  /**
   * Move it (Electron's `app.moveToApplicationsFolder`), asking `conflict` what to do with a copy already there. True:
   * moved, and the copy in Applications starts as this one quits. False: the user cancelled. Throws if it failed.
   */
  move(conflict: (type: 'exists' | 'existsAndRunning') => boolean): boolean
  /** A copy is in Applications already, not running: replace it (it goes to the Trash)? Synchronous, as `move` asks. */
  replace(): boolean
  /** Tell the user the move failed, and how to do it themselves. */
  failed(error: Error): Promise<void>
}

/**
 * Move the app to Applications. True: it's moved, and this copy has to quit for the moved one to start. False: it stays
 * (the user cancelled, or the move failed and they've been told).
 */
export async function moveToApplications(io: MoveIO): Promise<boolean> {
  try {
    // One that's running already takes over as this one quits (Electron's default): nothing to ask.
    return io.move((type) => type === 'existsAndRunning' || io.replace())
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    console.error('Moving the app to Applications:', error)
    await io.failed(error)
    return false
  }
}

/** At launch, translocated: offer the move. True: moved, so quit rather than start; false: launch as it is. */
export async function offerMove(io: MoveIO): Promise<boolean> {
  if (!await io.ask()) return false
  return moveToApplications(io)
}

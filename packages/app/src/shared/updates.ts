// Updating the app itself, as the window sees it (see main/updates.ts): where it stands, and what the window can ask.

/**
 * `off`: this app doesn't update itself (run from source, or packaged here rather than released). `translocated`: a
 * released app that can't update until it's moved to Applications (macOS runs it from a temporary copy, see
 * main/translocation.ts). `downloading`: a check found a newer release and fetches it. `ready`: downloaded, installed
 * as the app restarts (or next quits).
 */
export type UpdatePhase = 'off' | 'translocated' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'

export type UpdateState = {
  phase: UpdatePhase
  /** This app's version. */
  version: string
  /** The release downloaded, once it's `ready`. */
  next?: string
  /** When a check last found this the newest (ms since the epoch). */
  checked?: number
  /** Whether someone asked for this check (the menu, Settings), rather than the app on its own: its outcome is shown. */
  asked?: boolean
  /** What failed, and in which step: a check's failure shows in Settings; a download's or an install's in the notice too. */
  error?: string
  failed?: 'check' | 'download' | 'install'
}

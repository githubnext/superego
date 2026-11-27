// What both halves of files agree on: what it is (its folder pane described to the agent), the list the tree and quick
// open read, what a folder pane reads, and the folder pane's kind.
import type { ExtensionAbout } from '@superego/protocol'

/** The files in a thread's folder (`FileList`), given `{ thread }`; or in a folder, `{ cwd }` (a thread yet to start's). */
export const LIST = 'files.list'
/** The kind of pane that shows a folder. */
export const FOLDER = 'folder'
export type FileList = { files: string[]; truncated: boolean }
/**
 * What's in one folder of a thread's (`FolderEntries`), given `{ thread, path }` (`''`: its folder itself): as it is on
 * disk, ignored and untracked files too. A folder pane reads it a level at a time; a folder that isn't there, isn't a
 * folder or can't be read fails, saying why.
 */
export const ENTRIES = 'files.entries'
export type FolderEntry = { name: string; folder: boolean }
export type FolderEntries = { entries: FolderEntry[] }

export const about = {
  name: 'files', version: '1.0.0', api: '^5', title: 'Files', group: 'beside', description: 'A file tree beside the editor, quick open (⌘P), and folders opened in a pane.',
  panes: { [FOLDER]: '{ path }: a folder in the working folder ("" for the folder itself), as a tree to open its files from' },
} satisfies ExtensionAbout

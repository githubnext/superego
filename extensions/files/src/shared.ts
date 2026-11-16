// What both halves of files agree on: what it is (its folder pane described to the agent), the list the tree and quick
// open read, and the folder pane's kind.
import type { ExtensionAbout } from '@superego/protocol'

/** The files in a thread's folder (`FileList`), given `{ thread }`. */
export const LIST = 'files.list'
/** The kind of pane that shows a folder. */
export const FOLDER = 'folder'
export type FileList = { files: string[]; truncated: boolean }

export const about = {
  name: 'files', version: '1.0.0', api: '^2', title: 'Files', description: 'A file tree beside the editor, quick open (⌘P), and folders opened in a pane.',
  panes: { [FOLDER]: '{ path }: a folder in the working folder ("" for the folder itself), as a tree to open its files from' },
} satisfies ExtensionAbout

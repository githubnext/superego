// What both halves of files agree on.
import type { ExtensionAbout } from '@superego/protocol'

export const LIST = 'files.list'
/** The kind of pane that shows a folder. */
export const FOLDER = 'folder'
export type FileList = { files: string[]; truncated: boolean }

/** What this extension is, for both halves: optional, so a machine can turn it off and a profile can do without it. */
export const about = { name: 'files', title: 'Files', description: 'A file tree beside the editor, quick open (⌘P), and folders opened in a pane.' } satisfies ExtensionAbout

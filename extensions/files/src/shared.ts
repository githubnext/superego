// What both halves of files agree on.
export const LIST = 'files.list'
/** The kind of pane that shows a folder. */
export const FOLDER = 'folder'
export type FileList = { files: string[]; truncated: boolean }

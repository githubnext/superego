/// <reference path="./env.d.ts" />
// What `import … from 'superego/ui'` gives an author: the stable surface of the UI half. A profile's UI modules get
// these at run time (profile-ui.ts), and an author's types resolve against this file (`@superego/sdk/ui`). What's here
// follows the extension API's semver (`EXTENSION_API`). The window's own workings (its registry, the shell's state,
// the host's helpers) are `superego/unstable` (sdk-unstable.ts): there for the bundled extensions, and changed
// whenever the window changes. Bundled extensions import `@superego/app/ui`, which has both.

// Defining a UI half, and what its setup is given.
export {
  defineUiExtension, usePlacement, useApp, useNarrow,
  type BehaviourSlot, type EditorSlotProps, type EntryProps, type LinkAttributes, type LinkHandler, type LinkProps, type LinkWhere,
  type NewThreadField, type NewThreadFieldProps, type PaneKind, type PaneProps, type SettingsComponentProps, type SlotName, type SlotProps,
  type SpaceRailProps, type ToolCallProps, type ToolRow, type ToolRowCall, type ToolState, type UiApi, type UiExtension, type View,
  type ViewContext, type ViewProps, type WindowEvent, type WindowEvents, type WindowState, type WorkBlock, type WorkPart, type WorkRun,
  type WorkStatus,
} from './extension.tsx'
export { defineWindowAction as defineAction, type WindowAction, type WindowContext } from './actions.tsx'
export type { Dispatch } from './actions.tsx'
export type { Place, Placement } from './layout.ts'
export type { Store } from './local-state.ts'
export type { Completion, CompletionProvider, CompletionWord, ComposerWhere, SentBlock, SentWith } from './composer.ts'

// Reaching machines: calls, live values, features and versions.
export { call, has, useAppSetting, useMethod, useValue, version, type MethodState } from './client.ts'
export { useDispatch } from './Shell.tsx'
export { useAllThreads, useMachines, useSelection, useSessions, useThreads, type Selection } from './state.tsx'
export type { Session } from './sessions.ts'
export { keyLabel, useShortcut } from './keys.ts'
export { useComposer, useComposerClaim, type Composer, type ComposerClaim } from './ThreadView.tsx'
export { EXTENSION_API } from '@superego/protocol'
export type { Json, Status, StatusState, ThreadInfo } from '@superego/protocol'
export type { MachineEntry } from '../shared.ts'

// Components to build from; `h` for a module that isn't JSX.
export { createElement as h, Fragment } from 'react'
export { Markdown } from './Markdown.tsx'
export { ThreadRef } from './thread-ref.tsx'
export { transcriptLinks, type TranscriptLink } from './links.tsx'
export { parseWikilink, WIKILINK, wikilinkHref, type Wikilink } from './wikilinks.ts'
export { Picker, type PickerProps, type PickerRow } from './picker.tsx'
export { PaneHeader, useTabNote } from './panes.tsx'
export { Diff, parseDiff, type DiffFile } from './diff.tsx'
export { FileEditor, type FileEditorProps } from './file-editor.tsx'
export { SignInFlow, type SignInFlowProps } from './sign-in-flow.tsx'
export {
  Button, ContextMenu, Dialog, IconButton, List, ListItem, Menu, Panel, Popover, Select, StatusGlyph, statusLabel, Switch, TextArea,
  TextField, Tooltip, type SelectOption,
} from '@superego/ui'
export * from '@superego/ui/icons'

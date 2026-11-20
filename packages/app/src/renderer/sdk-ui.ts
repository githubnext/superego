/// <reference path="./env.d.ts" />
// What `import … from 'superego/ui'` gives an author: the stable surface of the UI half. A profile's UI modules get
// these at run time (profile-ui.ts), and an author's types are this file's, flattened (packages/sdk/types.ts). What's here
// follows the extension API's semver (`EXTENSION_API`). The window's own workings (its registry, the shell's state,
// the host's helpers) are `superego/unstable` (sdk-unstable.ts): there for the bundled extensions, and changed
// whenever the window changes. Bundled extensions import `@superego/app/ui`, which has both.

// In the order an author meets them (the order of the flattened 'superego/ui' they read).

// Defining a UI half, and what its setup is given.
export { defineUiExtension, type UiExtension, type UiApi } from './extension-api.ts'
export { defineWindowAction as defineAction, type WindowAction, type WindowContext } from './actions.tsx'
export type { Dispatch } from './actions.tsx'
export type {
  View, ViewContext, ViewProps, PaneKind, PaneProps, SlotProps, BehaviourSlot, EditorSlotProps, SpaceRailProps, ToolCallProps, ToolNote, ToolRow,
  ToolRowCall, ToolState, EntryProps, LinkHandler, LinkProps, LinkWhere, LinkAttributes, NewThreadField, NewThreadFieldProps, SettingsComponentProps,
  WindowEvent, WindowEvents, WindowState, WorkRun, WorkPart, WorkBlock, WorkStatus,
} from './extension-api.ts'
export type { Place, Placement } from '../shared/layout.ts'
export type { Store } from './local-state.ts'
export type { Completion, CompletionProvider, CompletionWord, ComposerWhere, SentBlock, SentWith } from './composer.ts'
export type { ImageItem } from './images.tsx'

// Reaching machines and the window: calls, live values, threads, the selection, features and versions.
export { useValue, useMethod, call, has, version, useAppSetting, type MethodState } from './client.ts'
export { useMachines, useThreads, useAllThreads, useSelection, useProjects, type Selection } from './state.tsx'
export type { Project } from './projects.ts'
export { useDispatch } from './Shell.tsx'
export { useApp } from './registry.tsx'
export { usePlacement } from './placement.tsx'
export { useNarrow } from './media.ts'
export { useShortcut, useRailShortcut, keyLabel } from './keys.ts'
export { useComposer, useComposerClaim, type Composer, type ComposerClaim } from './composer-view.tsx'
export { addToComposer, type ComposerItem } from './composer-items.ts'
export { EXTENSION_API, statusLabel, statusShape, statusWord, STATUS_WORDS } from '@superego/protocol'
export type { Json, Status, StatusShape, StatusState, ThreadInfo } from '@superego/protocol'
export type { MachineEntry } from '../shared/bridge.ts'

// Components to build from; `h` for a module that isn't JSX.
export { createElement as h, Fragment } from 'react'
export { Markdown } from './Markdown.tsx'
export { ThreadRef } from './thread-ref.tsx'
export { transcriptLinks, type TranscriptLink } from './links.tsx'
export { parseWikilink, WIKILINK, wikilinkHref, type Wikilink } from './wikilinks.ts'
export { Picker, type PickerProps, type PickerRow } from './picker.tsx'
export { PaneHeader, PaneNote, PaneButton, PaneMessage, useTabGlyph, useTabNote } from './panes.tsx'
export { WebView, hasWebViews, OVERLAYS, type WebViewHandle, type WebViewProps } from './web-view.tsx'
export type { PermissionAsk, SitePermission, WebViewEvent, WebViewState, WebViewPartition } from '../shared/bridge.ts'
export { HeaderChip, ThreadBadge, Chip, RailButton, factsOf } from './marks.tsx'
export { Diff, DiffStat, parseDiff, type DiffFile } from './diff.tsx'
export { FileEditor, type FileEditorProps } from './file-editor.tsx'
export { SignInFlow, type SignInFlowProps } from './sign-in-flow.tsx'
export {
  Button, ContextMenu, Dialog, Glyph, IconButton, List, ListItem, Menu, Panel, Popover, Select, StatusGlyph, StatusWord, Switch, TextArea,
  TextField, Tooltip, type GlyphShape, type SelectOption,
} from '@superego/ui'
export * from '@superego/ui/icons'

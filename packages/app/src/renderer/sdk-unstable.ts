/// <reference path="./env.d.ts" />
// What `import … from 'superego/unstable'` gives: the window's own workings, which the bundled extensions build on and
// which change whenever the window does, with no notice in the extension API's version. Reach for one only when the
// stable surface (`superego/ui`, sdk-ui.ts) has nothing for it, and say so where it's used.
export {
  fileKind, layoutOf, Slot, urlKind, useRegistry, type Registry,
} from './extension.tsx'
export { LAYOUT, type Layout } from './layout.ts'
export { runsBare } from './actions.tsx'
export { useActions, useKeymap } from './keys.ts'
export { useShell, useSidebar } from './state.tsx'
export { groupSessions, nest, sessionKey, SORT, type Session, type Sort } from './sessions.ts'
export { showSession } from './actions.tsx'
export { useLocalState } from './local-state.ts'
export { score } from './score.ts'
export { livePreview } from './live-markdown.ts'
export { channel, loadFonts, machine, useSettings, useThreadView, useWatch } from './client.ts'
export type { BridgeChannel } from '../shared.ts'
export { BADGE, browserNotice, desktopNotice, NOTIFY, signInNotice, threadNotice, unread, unreadCount, type NoticeStatus, type ThreadNotice } from '../shared.ts'
export type { MachineUpdate } from '../shared.ts'
export { describeImage, ImageFrame, imageFileName, imageSourceOf, useImageSource, useNear, type ImageItem, type LoadedImage } from './images.tsx'
export { Lightbox } from './lightbox.tsx'
export { driftNote, MachineDrift } from './machine-drift.tsx'
export { Output, unwrap } from './tool-rows.tsx'
export { FontPicker, isMonospace, TooltipProvider } from '@superego/ui'

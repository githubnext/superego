/// <reference path="./env.d.ts" />
// What `import … from 'superego/unstable'` gives: the window's own workings, which the bundled extensions build on and
// which change whenever the window does, with no notice in the extension API's version. Reach for one only when the
// stable surface (`superego/ui`, sdk-ui.ts) has nothing for it, and say so where it's used. It holds what the bundled
// extensions and blocks use, and no more: a test harness's parts are internals.ts.
export { useRegistry, type Registry } from './registry.tsx'
export { fileKind } from './lookups.ts'
export { Slot } from './placement.tsx'
export { MONO_FONT } from '../shared/app-settings.ts'
export { showProject } from './actions.tsx'
export { useShell } from './state.tsx'
export { groupProjects, SORT, unreadList, type PinnedThread, type Project, type Sidebar, type Sort } from './projects.ts'
export { isPinned, type Pin } from './pins.ts'
export { useLocalState } from './local-state.ts'
export { score } from './score.ts'
export { channel, useThreadView } from './client.ts'
export type { BridgeChannel } from '../shared/bridge.ts'
export { describeImage, ImageFrame, useImageSource } from './images.tsx'
export { Lightbox } from './lightbox.tsx'
export { MachineDrift } from './machine-drift.tsx'
export { Output } from './tool-rows.tsx'
// What's unread: one rule for the bell, notifications and the counts (see @superego/protocol's status.ts); in the
// window, as `unreadList` (projects.ts).
export { unread } from '@superego/protocol'

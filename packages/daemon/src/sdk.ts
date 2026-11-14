// What `import … from 'superego'` gives a profile's daemon modules: the stable author surface of the daemon half. The
// daemon hands profiles exactly these values at run time (profiles.ts, `provideSdk`), and an author's types resolve
// against this file (`@superego/sdk`, as the starter's tsconfig maps 'superego'). What's here follows the extension
// API's semver (`EXTENSION_API`); what isn't (the pi-durable harness, entry records) is unstable, and says so.
export { defineExtension, defineTool, hook, section, wrapSection, wrapTool } from '@earendil-works/pi-durable'
export { arr, bool, int, lit, nullable, num, obj, opt, RpcError, str, union, unknown } from '@superego/protocol'
export { defineProfile } from './profiles.ts'
export { defineAction, defineDaemonExtension } from './extension.ts'

export type { Extension as AgentExtension } from '@earendil-works/pi-durable'
export type {
  ActionDef, ActionInfo, DataIcon, DataPlace, DataView, ExtensionAbout, Exposure, Json, JsonSchema, Static, ThreadInfo,
  ViewAction, ViewContent, ViewItem,
} from '@superego/protocol'
export type { ProfileRef, ProfileSpec } from './profiles.ts'
export type {
  AgentChoice, ArchiveNote, ArchiveNotes, DaemonApi, DaemonExtension, LiveValue, MessageBlock, OutgoingMessage,
  ScopedValue, StatusContribution, SubmitTransform, ThreadCreating, ThreadDraft, ThreadHooks, ThreadState,
} from './extension.ts'
export type { DaemonContext } from './daemon.ts'

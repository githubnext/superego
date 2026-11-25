// What `import … from 'superego'` gives a profile's daemon modules: the stable author surface of the daemon half. The
// daemon hands profiles exactly these values at run time (profiles.ts, `provideSdk`), and an author's types are this
// file's, flattened (packages/sdk/types.ts). What's here follows the extension API's semver (`EXTENSION_API`); what
// isn't (pi-durable's entry records) is unstable, and says so.
//
// In the order an author meets them (the order of the flattened 'superego' they read): an extension's daemon half and
// what its setup is given, a profile, the agent's tools and schemas, then the shapes these use.
export { defineDaemonExtension, defineAction } from './extension.ts'
export type {
  DaemonExtension, DaemonApi, AgentChoice, AgentPart, AgentPartsAnswer, AgentPartsThread, ExtensionEntry, LiveValue, ScopedValue, ThreadState, ThreadHooks, ThreadStarting,
  ThreadDraft, OutgoingMessage, MessageBlock, SendTransform, StatusContribution, ArchiveNote, ArchiveNotes, AuthFlow, AuthFlowEvent, RunRecord, ToolCallRecord, MachineDraft, MachinePatch,
} from './extension.ts'
export type { DaemonContext } from './host.ts'
export type { LoginEnv } from './login-env.ts'
export { defineProfile } from './profiles.ts'
export type { LoadedSpec, ProfileSpec, ProfileRef, ProfileKey } from './profiles.ts'
export { defineExtension, defineTool, hook, section, wrapSection, wrapTool } from '@earendil-works/pi-durable'
export type { Extension as AgentExtension } from '@earendil-works/pi-durable'
export { arr, blockErrors, bool, int, lit, nullable, num, obj, opt, RpcError, str, union, unknown } from '@superego/protocol'
export { spawnGroup } from './process-group.ts'
export type { GroupExit, SpawnedGroup, SpawnGroupOptions } from './process-group.ts'
export type {
  ActionDef, ActionInfo, AuthEvent, AuthPrompt, DataIcon, DataPlace, DataView, ExtensionAbout, Exposure, Json, JsonSchema, MachineEntry, MessageOrigin, Static, ThreadInfo,
  Block, BlocksUse, Button, ListItem, Value,
} from '@superego/protocol'

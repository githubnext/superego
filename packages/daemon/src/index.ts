// The daemon, for the hosts that run it (the app's daemon process, `superego daemon`), the tests that open one, and
// the bundled extensions. A client process imports './client.ts' instead; a profile, './sdk.ts' (as 'superego').
export { OUTSIDE_THREADS, openDaemon, type Daemon, type DaemonOptions } from './daemon.ts'
export { listen, connectSocket } from './server.ts'
export { serveConnection } from './connection.ts'
export { serveDaemon } from './serve.ts'
export type { MachineReach } from './relay.ts'
export { defineDaemonExtension, type DaemonApi, type DaemonExtension, type ExtensionEntry, type LiveValue, type ScopedValue, type MessageBlock, type OutgoingMessage, type StatusContribution, type SendTransform, type MentionResolve, type MentionTarget } from './extension.ts'
export { defineAction, type AgentChoice, type AgentKind, type AgentKindDescription, type AgentKindOffer, type AgentKindThread, type AgentPart, type AgentPartsAnswer, type AgentPartsThread, type AuthFlow, type AuthFlowEvent, type ArchiveNote, type ArchiveNotes, type ThreadStarting, type ThreadDraft, type RunRecord, type ThreadHooks, type ThreadState, type ThreadStop } from './extension.ts'
export { readLoginEnv, type LoginEnv } from './login-env.ts'
export { slugOf, titleOf } from './names.ts'
export { SECRET_FILES } from './secrets.ts'
export { sniff, type Sniffed } from './image-kind.ts'
export { trusted } from './project-files.ts'

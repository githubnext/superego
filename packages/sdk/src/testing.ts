// 'superego/testing': test an extension as it runs. A daemon half against a real daemon with a scripted model
// (`testDaemon`, `say`, `callTool`), and whether what it started still runs (`isRunning`); a UI half in a real window over a fake bridge or a test daemon (`mountUi`,
// `fakeMachine`, `testThread`), in a DOM of its own. Run with `superego extension test`.
export { testDaemon, type TestDaemon, type TestDaemonOptions, type Watched } from './testing/daemon.ts'
export { callTool, callTools, say, type Turn } from './testing/model.ts'
export { isRunning } from './testing/process.ts'
export {
  daemonMachine, fakeMachine, mountUi, testThread, type FakeMachineOptions, type MountOptions, type Rendered, type TestMachine, type TestWindow,
} from './testing/window.tsx'

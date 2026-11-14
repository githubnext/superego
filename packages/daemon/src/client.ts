// What a client process needs to reach a daemon, without loading the daemon itself.
export { connectSocket, isListening } from './server.ts'
export { appEnv, daemonStarting, defaultDataDir, socketPath } from './paths.ts'
export { readBuild, readCommit, writeCommit } from './build.ts'
export { watchFiles } from './watch-files.ts'
export { installService, keepsRunning, startService, uninstallService } from './service.ts'

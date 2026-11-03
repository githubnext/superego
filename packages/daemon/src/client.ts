// What a client process needs to reach a daemon, without loading the daemon itself.
export { connectSocket, isListening } from './server.ts'
export { defaultDataDir, socketPath } from './paths.ts'

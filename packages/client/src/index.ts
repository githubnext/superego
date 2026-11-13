// How clients (the app, the CLI) reach daemons: the local socket, ssh, or any stdio command; the shared list of
// machines; and the check that the machine answering is the one expected.
export * from './shared.ts'
export { MachineStore } from './machines.ts'
export { openLocal, openMachine, openSsh, openVia, type Transport } from './transports.ts'
export { checkIdentity } from './identity.ts'
export { runUpdate, updateCommand, updateScript, wrapperOf, USUAL_PATH } from './update.ts'

// How clients (the app, the CLI) reach daemons: the local socket, ssh, or any stdio command; a link that keeps one
// connected; the shared list of machines; and the check that the machine answering is the one expected.
export * from './shared.ts'
export { MachineStore } from './machines.ts'
export { openLocal, openMachine, openSsh, openVia } from './transports.ts'
export { Link, type LinkOptions, type Transport } from './link.ts'
export { carriesFiles, upload, uploadAttachments } from './uploads.ts'
export { checkIdentity } from './identity.ts'

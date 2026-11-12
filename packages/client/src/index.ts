// How clients (the app, the CLI) reach daemons: the local socket, ssh, or any stdio command; a link that keeps one
// connected; the shared list of machines; and the check that the machine answering is the one expected.
export * from './shared.ts'
export { MachineStore } from './machines.ts'
export { openLocal, openMachine, openSsh, openVia } from './transports.ts'
export { Link, type LinkOptions, type Transport } from './link.ts'
export { MachineLinks, type MachineLinksOptions } from './links.ts'
export { machineHub } from './hub.ts'
export { carriesFiles, upload, uploadAttachments } from './uploads.ts'
export { checkIdentity } from './identity.ts'
export {
  classifySsh, controlPath, linkArgs, loginArgs, loginScript, masterAlive, shellQuote, terminalLaunch, type SshFailure,
} from './ssh.ts'
export {
  installedCommand, installMachine, MIN_NODE, nodeIsNewEnough, remoteBinDir, sshRun,
  type Installed, type InstallOptions, type RemoteResult, type RemoteRun,
} from './install.ts'
export { sshLinkArgs } from './transports.ts'
export { loginInTerminal, type LoginOptions } from './login.ts'

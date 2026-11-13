// links, daemon half: its declaration alone (see shared.ts).
import { defineDaemonExtension } from '@superego/daemon'
import { about } from './shared.ts'

export default defineDaemonExtension(about)

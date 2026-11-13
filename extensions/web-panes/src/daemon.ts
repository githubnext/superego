// web-panes, daemon half: its two pane kinds, described to the agent for open_pane. An artifact's files are served by
// the core (the app's artifact origin, or Web access's /artifact/), not here.
import { defineDaemonExtension } from '@superego/daemon'
import { about, ARTIFACT, PREVIEW } from './shared.ts'

export default defineDaemonExtension({
  ...about,
  setup(superego) {
    superego.pane(PREVIEW, '{ url }: a web page, such as a local dev server')
    superego.pane(ARTIFACT, '{ path }: an HTML file in the working folder, shown as a page; write it first')
  },
})

import { defineApp } from '@superego/protocol'

/** Superego itself: the core with every bundled extension. */
export default defineApp({
  name: 'Superego', id: 'superego', agent: 'Ego', url: 'https://github.com/githubnext/superego', bundleId: 'com.githubnext.superego', callbackPort: 1456,
  // The newest GitHub release's update.json (see docs/releasing.md).
  updateFeed: 'https://github.com/githubnext/superego/releases/latest/download/update.json',
})

import { defineApp } from '@superego/protocol'

/** Superego itself: the core with every bundled extension. */
export default defineApp({ name: 'Superego', id: 'superego', agent: 'Ego', url: 'https://github.com/mikker/superego', bundleId: 'com.githubnext.superego', callbackPort: 1456 })

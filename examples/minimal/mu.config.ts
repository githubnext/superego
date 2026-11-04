import { defineApp } from '@mu/protocol'

/** The core alone: no extensions. Sessions are picked from the top bar and started with `mu-minimal`. */
export default defineApp({ name: 'mu minimal', id: 'mu-minimal', glyph: 'µ·' })

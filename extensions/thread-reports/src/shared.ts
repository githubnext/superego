// thread-reports: what it is.
import type { ExtensionAbout } from '@superego/protocol'

/**
 * Report-back, optional: a thread started by another tells it when a run ends or it waits on a question. Its own
 * extension, so a profile turns it off (`without: ['thread-reports']`: its threads neither report nor are reported to)
 * while keeping the tools, and a thread without the tools still reports.
 */
export const about = {
  name: 'thread-reports', version: '1.0.0', api: '^2.2', title: 'Thread reports', description: 'Tell the thread that started one when it finishes, fails or waits on a question.',
} satisfies ExtensionAbout


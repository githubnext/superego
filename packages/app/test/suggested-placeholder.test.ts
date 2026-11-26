// @vitest-environment happy-dom
// What an extension suggests sending next shows in the empty composer, with ⏎ to send it; under a finger (a tap last)
// there's no ⏎ to press, the suggestion's chip is tapped, so it shows without. Back at a mouse, ⏎ again.
import { useEffect } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineUiExtension } from '../src/renderer/extension-api.ts'
import { useComposer } from '../src/renderer/composer-view.tsx'
import { mountUi, testDaemon, type TestDaemon, type TestWindow } from '../../sdk/src/testing.ts'

const suggests = defineUiExtension({
  name: 'suggests',
  setup(superego) {
    superego.slot('composer.above', function Suggests() {
      const { suggest } = useComposer()
      useEffect(() => { suggest(['Run the tests']); return () => suggest(undefined) }, [suggest])
      return null
    })
  },
})

const placeholder = () => document.querySelector<HTMLTextAreaElement>('.dock textarea')?.placeholder
const press = (pointerType: string) => window.dispatchEvent(new PointerEvent('pointerdown', { pointerType, bubbles: true }))

let daemon: TestDaemon
let ui: TestWindow
beforeEach(async () => { daemon = await testDaemon({ model: 'echo' }) })
afterEach(async () => { await ui?.unmount(); await daemon.close() })

it('hints ⏎ for a suggestion with a mouse or a keyboard, and not under a finger', async () => {
  const thread = await daemon.thread(undefined, { title: 'suggested' })
  ui = await mountUi({ window: true, extensions: [suggests], machines: [daemon], select: { thread: thread.id } })
  press('mouse')
  await ui.until(() => placeholder() === 'Run the tests  ⏎', 'the suggestion, with ⏎')
  press('touch')
  await ui.until(() => placeholder() === 'Run the tests', 'the suggestion alone, under a finger')
  press('mouse')
  await ui.until(() => placeholder() === 'Run the tests  ⏎', 'with ⏎ again')
})

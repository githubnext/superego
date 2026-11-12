// Shown in a thread whose profile brings UI from another machine that isn't allowed to run in this window yet.
import { useState } from 'react'
import { Button } from '@superego/ui'
import { useRegistry, type SlotProps } from './extension.tsx'
import { allowProfileUi, usePendingUi } from './profile-ui.ts'

export function ProfileUiNotice({ machine, thread }: SlotProps['thread.header']) {
  const registry = useRegistry()
  const ui = usePendingUi(machine.id, thread.profile)
  const [error, setError] = useState<string>()
  if (!ui) return null
  return (
    <div className="ui-notice" role="status">
      <div>
        <b>{ui.label}</b>'s <b>{ui.profile.name}</b> profile wants to run code in this window. That code can reach every machine connected here.
      </div>
      <div className="ui-notice__actions">
        <Button onClick={() => { setError(undefined); allowProfileUi(registry, ui).catch((e: Error) => setError(e.message)) }}>Allow</Button>
      </div>
      <details className="ui-notice__sources">
        <summary>View the code ({ui.sources.length} {ui.sources.length === 1 ? 'file' : 'files'})</summary>
        {ui.sources.map((source) => <div key={source.path}><code>{source.path}</code><pre>{source.code}</pre></div>)}
      </details>
      {error && <p className="setting__error">{error}</p>}
    </div>
  )
}

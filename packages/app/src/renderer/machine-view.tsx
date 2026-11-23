// A global profile's window view, told the machine its profile is on (`ViewProps<'window'>`'s `machine`).
import type { ComponentType } from 'react'
import type { ViewProps } from './extension-api.ts'
import { useMachines } from './state.tsx'

/** `Component`, given `machine` (by id) as the window's entry of it, while the window has it. */
export function onMachine(machine: string, Component: ComponentType<ViewProps>): ComponentType<ViewProps> {
  return function OnMachine(props: ViewProps) {
    const entry = useMachines().find((m) => m.id === machine)
    return <Component {...props} {...(entry ? { machine: entry } : {})} />
  }
}

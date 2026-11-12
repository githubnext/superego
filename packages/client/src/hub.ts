// A daemon's links to the other machines: the same `machines.json` the app and the CLI on its computer keep, followed
// as it changes, with the same identity checks. A daemon given this (see the daemon's relay.ts) serves every machine
// through one door, to a browser or an agent. With no machines in the file it holds no links.
import { hostname } from 'node:os'
import { RpcError, type AppConfig, type MachineInfo } from '@superego/protocol'
import type { MachineReach } from '@superego/daemon'
import { MachineLinks } from './links.ts'
import { MachineStore } from './machines.ts'

export function machineHub({ app, dataDir, self, store = new MachineStore(dataDir) }: { app: AppConfig; dataDir: string; self: MachineInfo; store?: MachineStore }): MachineReach {
  const listeners = new Set<(machine: string, method: string, params: unknown) => void>()
  const emit = (machine: string, method: string, params: unknown) => { for (const listener of listeners) listener(machine, method, params) }
  const links = new MachineLinks({
    app, dataDir, store, self: self.id,
    // Named in the far daemon's client list as this computer, a daemon rather than a window.
    client: `${app.id}-daemon`, clientLabel: hostname(),
    onEvent: emit,
    onChange: () => emit('$machines', '$machines', null),
  })
  const unfollow = links.follow()
  return {
    list: () => links.entries(),
    async call(machine, method, params) {
      const link = links.get(machine)
      if (!link) throw new RpcError('disconnected', `${store.get(machine)?.label ?? machine} is turned off`)
      return link.call(method, params)
    },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    reconnect: (id) => links.restart(id),
    close() { unfollow(); links.close(); store.close() },
  }
}

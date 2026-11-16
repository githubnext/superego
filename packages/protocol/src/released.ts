// What protocol generation 2 released: the core's methods and actions, notifications and features, by name. A daemon
// of this generation still answers every one (a test holds it to that), so any client of the generation finds what it
// knew. Add to it as things are released; take nothing out but with a new generation, when it starts again. An
// extension's own names aren't here: they're versioned by the extension (`ExtensionAbout.version`).
import type { Feature, Notifications } from './methods.ts'

export const RELEASED = {
  generation: 2,
  /** Methods and actions, as `hello.methods` lists them. */
  methods: [
    'action.list', 'action.log', 'action.run', 'agent.models', 'auth.cancel', 'auth.signIn', 'auth.signOut',
    'auth.respond', 'auth.retry', 'daemon.restart', 'extension.declare', 'extension.inspect', 'file.find', 'file.read', 'file.stat',
    'file.watch', 'file.write', 'hello', 'pane.close', 'pane.focus', 'pane.open', 'pane.update', 'profile.allow',
    'profile.list', 'profile.module', 'profile.reload', 'profile.ui', 'settings.set', 'settings.watch', 'thread.stop',
    'thread.archive', 'thread.start', 'thread.history', 'thread.list', 'thread.rename', 'thread.seen', 'thread.setProfile',
    'thread.steer', 'thread.send', 'thread.unarchive', 'thread.watch', 'thread.withdraw', 'threads.watch', 'unwatch', 'value.watch',
    'web.devices', 'web.pair', 'web.rename', 'web.revoke',
    'ping', 'ch.open', 'clients.watch', 'client.perform', 'machines.watch', 'machine.reconnect', 'relay.call',
  ],
  notifications: [
    'watch.ops', 'watch.end', 'threads.changed', 'settings.changed', 'auth.event', 'value.changed', 'file.changed',
    'features.changed', 'ch.data', 'ch.ack', 'ch.end', 'ch.abort', 'clients.changed', 'client.perform', 'machines.changed',
    'relay.event',
  ] satisfies (keyof Notifications)[],
  /** Features added since the generation began (`FEATURES`): what it began with isn't a feature, it's the protocol. */
  features: [] satisfies Feature[],
} as const

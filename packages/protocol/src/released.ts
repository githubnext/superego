// What protocol generation 1 released: the core's methods and actions, notifications and features, by name. A daemon
// of this generation still answers every one (a test holds it to that), so any client of the generation finds what it
// knew. Add to it as things are released; take nothing out but with a new generation, when it starts again. An
// extension's own names aren't here: they're versioned by the extension (`ExtensionAbout.version`). Nor are the
// aliases kept for older clients (ALIASES), which go at their milestones.
import type { Feature, Notifications } from './methods.ts'

export const RELEASED = {
  generation: 1,
  /** Methods and actions, as `hello.methods` lists them. */
  methods: [
    'action.list', 'action.log', 'action.run', 'agent.models', 'auth.cancel', 'auth.login', 'auth.logout',
    'auth.respond', 'auth.retry', 'daemon.restart', 'extensions.declare', 'extensions.inspect', 'file.find', 'file.read', 'file.stat',
    'file.watch', 'file.write', 'hello', 'pane.close', 'pane.focus', 'pane.open', 'pane.update', 'profile.allow',
    'profile.list', 'profile.module', 'profile.reload', 'profile.ui', 'settings.set', 'settings.watch', 'thread.abort',
    'thread.archive', 'thread.create', 'thread.history', 'thread.list', 'thread.rename', 'thread.seen',
    'thread.submit', 'thread.unarchive', 'thread.watch', 'thread.withdraw', 'threads.watch', 'unwatch', 'value.watch',
    'web.devices', 'web.pair', 'web.rename', 'web.revoke',
  ],
  notifications: [
    'watch.ops', 'watch.end', 'threads.changed', 'settings.changed', 'auth.event', 'value.changed', 'file.changed',
    'features.changed',
  ] satisfies (keyof Notifications)[],
  features: [
    'threads', 'settings', 'auth', 'restart', 'restart-env', 'actions', 'hidden-threads', 'data-views', 'scoped-values',
  ] satisfies Feature[],
} as const

# Machines

Each machine runs its own daemon, with its own agents, providers, settings and MCP servers. The app on this computer
reaches other machines over ssh (or any command that pipes stdio), and a project on one works like a local one. The
same daemon can serve the window to a browser or a phone.

## Adding a machine

Settings → Machines → Add, or:

```sh
superego machines add <ssh-target> [--name N] [--command C]
superego machines add --via '<command>' [--name N]   # any command piping stdio to the far side
```

The app reaches it with `ssh <target> superego connect --start`, so the machine needs `superego` on its `PATH`.

### Installing Superego there

From a checkout of this repository, on this computer:

```sh
ssh <host> 'bash -s -- --release' < scripts/install-machine.sh
```

On macOS that downloads the newest release with `gh` (signed in there), puts `Superego.app` in `~/Applications` and
writes `~/.local/bin/superego`. On Linux, which has no build of the app, it installs a checkout at the release's tag in
`~/dev/superego` (Node 22.18 or later). `--release <version>` picks a release.

A non-interactive ssh shell may not have `~/.local/bin` on its `PATH`; then add the machine with that path:
`superego machines add <host> --command '~/.local/bin/superego connect --start'`.

### Updating it

A machine running an older (or newer) Superego than this computer gets a dot beside its name in the sidebar and in
Settings → Machines. Update there (or `⌘K` Update Superego on a machine, or `superego machines update <host>`) runs
install-machine.sh again over ssh and reconnects, asking first if agents are working there, since the daemon restarts.
They resume after.

### Logging in

ssh runs without a terminal and shares one connection per host. A host that wants a password, a code or a hardware
key shows as "needs login": `superego machines login <machine>` (or Log in in Settings → Machines, which opens
Terminal) logs in once, and the app's links use that connection for four hours. A changed or unknown host key shows as
its own state, with ssh's message. When another machine answers at the same address (after a reinstall, say), Trust
this machine takes it as this one.

### Keeping the daemon running

`superego daemon install`, run on the machine, runs its daemon as a service (a systemd user unit with lingering, or a
launchd agent), so it outlives logouts and reboots. Settings → Machines and `superego machines` warn when a remote
daemon will end at logout or reboot. Under a service, `superego daemon stop` stays stopped until the next connection
starts it.

A daemon the service started has only the service's environment: without an ssh agent there, its own links to other
machines may need `superego machines login <machine>` on that computer.

### Model keys on a machine

The daemon takes model keys from the providers' own variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) when none is
stored in Settings. A restart keeps the environment the daemon started with and adds that of the shell asking for it.
Where those keys are sealed, as on a [workbox](https://github.com/githubnext/workboxes), restart the daemon from a
terminal on the box after each boot: `box run superego daemon restart`.

## Agents on other machines

An agent's thread tools take a `machine`: a thread it starts there belongs to that machine. Each daemon links to the
machines in its own `~/.superego/machines.json` (the list the app keeps), so a browser or an agent there reaches them
through it.

An agent on a machine whose window is on another computer is told so: `localhost` there isn't yours.

### localhost on another machine

A Browser pane at `localhost:<port>` on another machine loads that machine's page: the app listens on this computer at
the same port when it's free (else another, which the pane's header says) and carries each connection over the
machine's link. Cookies and redirects to `localhost:<port>` work as they would there, and your own browser on this
computer reaches the forward too, while the app runs.

What doesn't work: a page calling another of the machine's ports (open that one too, so it's forwarded), absolute
links to the port when it was taken here, anything that must reach the machine from outside (a webhook, an OAuth
callback to a public address), and a browser on Web access, which can't listen.

### Profiles from other machines

A profile's UI from another machine runs in this computer's window only once you allow it here, for the exact files
the window received; any change asks again. Until then its threads work without it, and a notice over the message box
offers Allow, with its files to read. Allowed, it runs with the window's full authority, over every machine.

Settings → Machines lists what's allowed, with Revoke. From a shell: `superego profile allow-ui <name> -m <machine>`.
A data-only view (blocks from a daemon half) runs no code in the window, so it needs no allowing; its buttons still
run that machine's actions.

## In a browser or on a phone

Settings → Web access serves the app to this computer, or over Tailscale (the daemon sets up
`tailscale serve`, so it's at `https://<machine>.<tailnet>.ts.net` on your tailnet; Tailscale 1.94 or later). Then
**Pair a device**: scan the QR code or open its link on the device, once, within 5 minutes. A page added to a phone's
home screen keeps cookies of its own, so it asks for the code shown beside the link.

Over Tailscale, a device logged in as you can skip the code: the first time it opens the page, it's listed as
waiting, and gets in once you approve it from somewhere already in. Your login alone lets nothing in.

Devices are listed there to rename, approve or revoke (which closes their connections at once); one unused for 90
days is forgotten. From a terminal: `superego web pair`, `superego web devices`, `superego web approve <device>`.

A browser shows every machine the serving daemon reaches. Adding, removing, logging in to and updating machines stay
in the desktop app. Settings → Connected lists who is using it now: windows, browsers, command lines and
other machines' daemons.

On a phone, the bar at the top opens the drawer (threads, Ego, Unread and Settings) and, from the thread's title, its
sheet: where it runs, the model, archiving, and its panes. Each pane is a screen wide; swipe between the thread and its
panes. A browser notifies like the desktop app once you allow it; a phone's browser doesn't yet.

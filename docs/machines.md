# Machines

Each machine runs its own daemon, with its own agents, providers, settings and MCP servers. The app reaches other
machines over ssh (or any command that pipes stdio); a project there works like a local one. Any daemon can also serve
the window to a browser or a phone.

## Add a machine

Settings → Machines → Add, or:

```sh
superego machines add <ssh-target> [--name N] [--command C]
superego machines add --via '<command>' [--name N]   # any command piping stdio to the far side
```

The app runs `ssh <target> superego connect --start`, so the machine needs `superego` on its `PATH`. If a
non-interactive ssh shell lacks `~/.local/bin` on its `PATH`, give the full path:
`--command '~/.local/bin/superego connect --start'`.

### Install Superego there

From a checkout of this repository:

```sh
ssh <host> 'bash -s -- --release' < scripts/install-machine.sh   # --release <version> for another
```

| On | It installs |
|---|---|
| macOS | the newest release, downloaded with `gh` (signed in there), as `~/Applications/Superego.app`, and `~/.local/bin/superego` |
| Linux | a checkout at the release's tag in `~/dev/superego` (needs Node 22.18 or later) |

### Update it

A machine on another version gets a dot beside its name in the sidebar and in Settings → Machines. Update there,
`⌘K` Update Superego on a machine, or `superego machines update <host>`. The daemon restarts, so it asks first if
agents are working; they resume after.

### Log in

ssh runs without a terminal, sharing one connection per host. A host that wants a password, a code or a hardware key
shows as "needs login": run `superego machines login <machine>` (or Log in in Settings → Machines). The connection
then lasts four hours. A changed or unknown host key shows ssh's message; Trust this machine accepts a reinstalled one
at the same address.

### Keep the daemon running

```sh
superego daemon install    # on the machine: a systemd user unit (with lingering) or a launchd agent
```

It then outlives logouts and reboots; Settings → Machines warns when a remote daemon won't. Under a service,
`superego daemon stop` stays stopped until the next connection. A service has no ssh agent, so that daemon's own links
to other machines may need `superego machines login <machine>` there.

### Model keys

The daemon reads the providers' own variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) when Settings stores no key.
A restart keeps the daemon's environment and adds that of the shell asking. Where keys are sealed per boot (a
[workbox](https://github.com/githubnext/workboxes)), restart from a terminal on the box after each boot:
`box run superego daemon restart`.

## Agents on other machines

An agent's thread tools take a `machine`; a thread started there belongs to that machine. Each daemon reaches the
machines in its own `~/.superego/machines.json`. An agent whose window is on another computer is told that its
`localhost` isn't yours.

### localhost on another machine

A Browser pane at `localhost:<port>` on another machine loads that machine's page. The app listens on the same port
here (another if it's taken; the pane's header says) and forwards each connection. Cookies and redirects work as they
would there, and your own browser here reaches the forward too, while the app runs.

Doesn't work: a page calling another of the machine's ports (open that one too), absolute links to a port that was
taken here, anything reaching the machine from outside (webhooks, OAuth callbacks to a public address), and a browser
on Web access.

### Profiles from other machines

Another machine's profile UI runs in your window only once you allow it, for exactly the files received; any change
asks again. Until then its threads work without it, and a notice over the message box offers Allow. Allowed, it has
the window's full authority over every machine.

```sh
superego profile allow-ui <name> -m <machine>   # or Allow on the notice; Settings → Machines lists them, with Revoke
```

A data view (blocks from a daemon half) runs no code in the window and needs no allowing; its buttons still run that
machine's actions.

## In a browser or on a phone

Settings → Web access serves the app on this computer, or over Tailscale at `https://<machine>.<tailnet>.ts.net`
(Tailscale 1.94 or later; the daemon sets up `tailscale serve`). Then **Pair a device**: scan the QR code or open the
link on it, within 5 minutes. A page saved to a phone's home screen has its own cookies, so it asks for the code shown
beside the link.

Over Tailscale, a device logged in as you can skip the code: it's listed as waiting, and gets in once you approve it
from a device already in.

```sh
superego web pair                 # a link, a QR code and a code
superego web devices              # rename, approve or revoke them in Settings → Web access too
superego web approve <device>
```

Revoking closes a device's connections at once; one unused for 90 days is forgotten. Settings → Connected lists who is
connected now: windows, browsers, command lines, other machines' daemons.

A browser shows every machine the serving daemon reaches; adding, removing, logging in to and updating machines stay in
the desktop app.

On a phone, the top bar opens the drawer (threads, Ego, Unread, Settings) and, from the thread's title, its sheet
(where it runs, the model, archiving, its panes). Swipe between the thread and its panes. A phone's browser doesn't
notify yet.

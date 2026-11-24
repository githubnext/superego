# When something doesn't work

## Where errors go

| What failed | Where it says so |
|---|---|
| a profile or its daemon halves didn't load | the command or message that started a turn: `superego start -P <name>`, `superego send <thread> …`, the app's composer. Also `~/.superego/daemon.log` |
| a tool threw | the transcript, as the tool call's error result (the model sees it too) |
| an action threw | its caller: `superego do …` prints it; `superego actions log` keeps the latest, with errors |
| a profile's UI didn't load or a component threw | the window's developer tools console (View → Toggle Developer Tools, ⌥⌘I) |
| the daemon itself | `~/.superego/daemon.log` |

To load a profile without a model, `superego start . -P <name>`: it prints the error if it can't load (else it starts
an empty thread; archive it). `SUPEREGO_MODEL=faux` in the daemon's environment makes turns echo.

## Common causes

- **"allow it first"**: a project's profile changed since it was allowed. The user allows it in the window (where the
  thread asks, or Settings → Profiles) or with `superego profile allow <name>` in their own terminal. An agent can't:
  tell them.
- **"No profile …"**: profiles are looked for from the thread's folder up to its repository's top (the folder alone
  outside one), then in `~/.superego/profiles`; never in a folder another user can write. Check with
  `superego profile` in that folder.
- **"must export default …"**: `profile.ts` exports `defineProfile({ … })`; each `extensions` module exports an
  extension with a `name`; each `ui` module exports `defineUiExtension({ name, setup })`.
- **"must name things \"orders.<name>\""**: a daemon half's actions and values start with its own name.
- **"Action … is already defined"**: two extensions (or two profiles) define the same id; ids are per machine.
- **A UI module "imports X"**: a profile's UI can import only `react`, `react/jsx-runtime`, `superego/ui` and its own
  files.
- **A change doesn't show**: send the thread a message. The daemon reloads a profile on the next turn; the window its
  UI when a shown thread of it moves on ([ui.md](ui.md#when-the-ui-loads)). Superego's own code needs
  `superego daemon restart`.
- **A pane kind isn't found**: the profile's UI registers it, only for that profile's threads. Check `ui` in
  `profile.ts`, and the console.
- **The agent never opens the pane**: describe it under `panes` in `profile.ts`, with its params, and say in `prompt`
  when to open it.

## Looking around

```sh
superego daemon status         # running, and on the installed build?
superego threads --json        # each thread's status, profile and folder
superego read <thread> --wait  # a thread's state and last answer, once it stops working
superego actions --all         # every action registered, extensions' included
superego actions log           # recent actions, from anywhere, with errors
superego settings              # this machine's settings, incl. which extensions are on
tail -f ~/.superego/daemon.log
```

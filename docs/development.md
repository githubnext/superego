# Developing Superego

[AGENTS.md](../AGENTS.md) has the house rules and which checks to run when. [design.md](design.md) describes the
architecture; [the skill's `bundled` topic](../packages/cli/skill/bundled.md) adding a bundled extension.

## Commands

```sh
pnpm install
pnpm dev                # the app; its daemon lives in ~/.superego
pnpm dev --fresh        # the app as it comes: a new, empty data dir (or --home <dir> for one of your own)
pnpm typecheck          # tsc -b (TypeScript 7, native), incremental
pnpm test               # unit + daemon/CLI end to end, with scripted models
pnpm smoke              # the app end to end, headless: nothing reaches the screen
pnpm --filter superego showcase /tmp/shots   # scripted threads, screenshotted
pnpm --filter superego package               # Superego.app in app/dist, signed ad hoc for this Mac
pnpm bundle             # …signed with a Developer ID and notarized (see releasing.md)
pnpm release 0.4.0      # main, notarized, tagged and published as a GitHub release (releasing.md)
pnpm link:cli           # `superego` on your PATH (~/.local/bin/superego -> app/bin/superego.ts)
pnpm --filter @superego/site dev   # the docs site, with live reload
pnpm eval               # how well agents extend Superego (evals/README.md)
```

Tests, typecheck, smoke and showcase take turns across the machine (two at a time; `SUPEREGO_CHECK_SLOTS`), and smoke
and showcase build the app only when its sources changed.

GitHub Actions runs `pnpm typecheck`, `pnpm test` and the site's build on every push to `main` and every pull request
to it, on Linux ([.github/workflows/ci.yml](../.github/workflows/ci.yml)). Not smoke: that stays a check run by hand.

After changing daemon code, `superego daemon restart` runs it (the dev app offers the same).

## Layout

| | |
|---|---|
| `app` | the Superego app: Electron main, window, daemon entry, the `superego` command, icons |
| `packages/protocol` | the contract: methods, JSON-RPC peer, actions, status; blocks (the JSON UI agents and data views draw) |
| `packages/settings` | the settings registry, used by daemons (per machine) and the app |
| `packages/daemon` | the daemon: pi-durable harness, threads, files, profiles, models and sign-in; the daemon half of the extension API |
| `packages/client` | reaching daemons: local socket, ssh, any stdio command; the machine list |
| `packages/cli` | the command line, and the skill (`packages/cli/skill`) |
| `packages/ui` | component kit and design tokens |
| `packages/app` | main process, window, preload, build and packaging; panes, the editor, the navigator, notifications; the blocks renderer; the UI half of the extension API |
| `packages/sdk` | what an extension's author imports: `superego`, `superego/ui`, `superego/testing`, `superego/unstable` |
| `site` | the website and docs, built from `docs/` and the skill (`site/pages.ts`) |
| `evals` | agents extending Superego with only the skill and docs, scored |

The bundled extensions, in `extensions/`. Required ones can't be turned off; the rest can, per machine (Settings →
Extensions) or per profile (`without`).

| | |
|---|---|
| `threads` | the sidebar: projects and their threads; the thread tools' rows and `thread:` links (UI; required) |
| `worktrees` | a git worktree of its own for a thread that asks; the branch in the title bar (required) |
| `thread-tools` | the agent's `thread_*` tools |
| `thread-reports` | a thread started by another tells it when it finishes, fails or waits on a question |
| `ego` | Ego, Superego's own agent: one hidden thread per machine, its prompt and setup tools |
| `agent-ui` | `ask_user`, `ask_ui`, `show_ui`, `open_ui`/`update_ui`: questions and blocks from the agent |
| `git` | Changes (`⌘⇧D`): the thread's folder's changes |
| `github` | a thread's pull requests: attached by `gh pr create`, its branch or by hand; their state in the title bar and sidebar, their own pane, `pr_view` |
| `browser` | Browser: a web page or an HTML file the agent wrote, beside the thread (UI) |
| `files` | the file tree beside the editor and quick open (`⌘P`) |
| `images` | `show_images`, and the images in the thread |
| `unread` | `⌘U` and `⌘.`: what agents have for you that you haven't seen (UI) |
| `focus` | focus mode (`⌘⇧F`): the sidebar narrowed to the threads you focus (`⌘⌥F`) and what needs you (UI) |
| `links` | `⌃O`: the links in the thread (UI) |
| `mermaid` | ```` ```mermaid ```` blocks drawn as diagrams, by Pele, in threads and rendered files (UI) |
| `mentions` | `@` in the composer names another thread, a file, or an extension's thing (`composer.mention`) |
| `skills` | skills from `~/.agents/skills`: in the prompt, `$name` in the composer, a view listing them |
| `suggestions` | after each answer, what you might send next |
| `schedules` | wake a thread at a time or every so often (`schedule`); the clock in its header and on its row |
| `tasks` | `task_start`/`task_finish`, and the transcript folded by task |
| `terminal` | a shell beside a thread, run by the machine; drawn by ghostty-web |
| `processes` | servers, watchers and long builds a thread (or a folder) runs, outliving the daemon; `process_*`, the chip, the Processes pane, reports when one ends |
| `mcp-servers` | MCP servers for the agents in threads ([mcp.md](mcp.md)) |
| `claude-agent` | threads that run the user's own Claude Code ([claude-agent.md](claude-agent.md)) |

## Environment

Besides the variables in [the command's docs](../packages/cli/skill/cli.md#environment), for tests and development:

| Variable | |
|---|---|
| `SUPEREGO_MODEL` | also `replay:<file>`: a recording as the default model |
| `SUPEREGO_REPLAY` | offer a recording as the model `replay/replay` beside the default |
| `SUPEREGO_RECORD` | append every real model answer to this JSONL file, for replaying later |
| `SUPEREGO_REPLAY_SPEED` | replay pace in tokens per second (default 120; 0 is instant) |
| `SUPEREGO_HEADLESS` | the app shows nothing: no window, Dock icon, notification or focus |
| `SUPEREGO_UPDATE_FEED` | another update feed for a packaged app ([releasing.md](releasing.md#automatic-updates)) |

## A machine on main

A remote machine can run a checkout of `main` instead of a release ([machines](machines.md#install-superego-there)):

```sh
gh repo clone githubnext/superego ~/dev/superego && ~/dev/superego/scripts/install-machine.sh   # again to update
```

It pulls, installs the dependencies (no Electron: the daemon runs on Node 22.18+, from mise when it's there) and builds
the window, then writes `~/.local/bin/superego` and restarts a running daemon. Update in the app runs it again.

## A registry mirror

`pnpm-lock.yaml` names only the public npm registry: integrity hashes, no tarball URLs, so pnpm fetches each package
from whatever registry the machine is configured with. A machine that can't reach registry.npmjs.org names its mirror
in its own pnpm config, never in the repo (a project `.npmrc` would override every machine's):

```sh
cd ~ && pnpm config set --global registry https://packagefeedproxy.microsoft.io/npm/
```

(or `registry=` in `~/.npmrc`, `PNPM_CONFIG_REGISTRY` for one shell, `SUPEREGO_REGISTRY` for one run of
install-machine.sh). A frozen install (`pnpm install --frozen-lockfile`, or any install in CI) never rewrites the
lockfile, and neither does a plain `pnpm install` while the manifests match it.

Adding or updating a dependency does resolve through the mirror, whose metadata names tarballs on another host and
often only sha1 hashes. `.pnpmfile.mjs` puts each package resolved that way back as registry.npmjs.org has it: no
tarball URL, npm's sha512, once npm's metadata for that version confirms the mirror's tarball is the same one. That
needs registry.npmjs.org's metadata (not its tarballs); where it can't be reached, the change fails, naming the
packages, and leaves the lockfile alone: make it with `--registry=https://registry.npmjs.org/`, or on a machine that
reaches npm. The lockfile records the pnpmfile's checksum, so a change to `.pnpmfile.mjs` goes with a `pnpm install`
that updates it. Resolving takes only versions a week old or more (`minimumReleaseAge` in `pnpm-workspace.yaml`), so a
mirror a few days behind npm carries all of them.

pnpm itself, where registry.npmjs.org is blocked, verifies the version `packageManager` pins against the registry in
its own config, not `NPM_CONFIG_REGISTRY` (`ERR_PNPM_PNPM_ENGINE_IDENTITY_UNVERIFIABLE`): set the mirror there as above.

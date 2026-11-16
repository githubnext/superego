# Superego

One app for running agents: a desktop app, a daemon per machine that keeps agents running when the app is closed, and
the same window in a browser or on a phone. What an agent is (its model, prompt, tools, extensions, panes) comes from
**profiles**: files in `~/.superego/profiles/` or in a project's own `.superego/profiles/`, so a repo can carry the
harness it needs.

```sh
pnpm install
pnpm dev
```

More in [docs/](docs/): [overview](docs/overview.md), [plan](docs/plan.md), [releasing](docs/releasing.md).

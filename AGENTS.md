# Working on Superego

Many agents work on this repo at once, each in a git worktree of its own, all on one machine.

## House rules

- Work in your own worktree. Never reset, stash or overwrite anything in the main checkout.
- Merge to `main` by rebasing onto the local `main`, then `git -C <main checkout> merge --ff-only <your branch>` (the main
  checkout is the first in `git worktree list`). If that fails, rebase again and retry.
- Don't push.

## Checks

- **While working:** `pnpm typecheck` (incremental: quick after the first run) and only the tests related to what you
  changed: `pnpm vitest related --run <files>`, or a package's own (`pnpm test packages/cli`).
- **Before merging:** the full `pnpm test` and `pnpm smoke`, once each. Run them with `ELECTRON_RUN_AS_NODE` and
  `ELECTRON_RENDERER_URL` unset (`env -u ELECTRON_RUN_AS_NODE -u ELECTRON_RENDERER_URL pnpm smoke`): agents started from
  the dev app inherit them, and they make Electron run as plain Node or load the dev server's page instead of the build.
- **After a rebase:** `pnpm install` if `pnpm-lock.yaml` changed; then `pnpm typecheck` and the related tests again.
  Run smoke again only if the rebase brought in changes under `app/` or `packages/app`, or to the protocol
  (`packages/protocol`).

`pnpm test`, `pnpm typecheck`, smoke, showcase and `app/test/look.sh` share a few slots across the whole machine
(`scripts/check.ts`; `SUPEREGO_CHECK_SLOTS`, default 2), so "waiting for a check slot…" and a short wait are normal.
Smoke, showcase and look build the app first only when its sources changed. A new package or extension also goes in
the root `tsconfig.json`'s references, or `pnpm typecheck` skips it.

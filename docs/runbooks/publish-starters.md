# Runbook — publish `@snugprotocol/starters` to npm

**What this covers:** the one-time npm setup, staging, the dry run, the publish, and what to do after — for the package every kit shelf loads its starters from ([ADR-0073](../decisions/0073-starters-package-lock.md)). Publishing is an **owner act** that needs an explicit ask in the session (CLAUDE.md rule 4). An npm version can **never** be republished, so nothing here has an undo.

## Once: the npm org and your login

1. Sign in at npmjs.com with 2FA on (a passkey or security key preferred).
2. Create the free org **`snugprotocol`** at https://www.npmjs.com/org/create (unlimited public packages). This claims the `@snugprotocol` scope; until it exists anyone can take the name the kit hard-codes. Optionally add a second org owner for recovery (the same single-custodian concern as the updater key and the GitHub org).
3. On the publishing machine, on Node 22: `npm login`. Check: `npm whoami` prints your user; `npm config get registry` prints `https://registry.npmjs.org/`; `npm config get @snugprotocol:registry` prints `undefined`.

## Stage (on a feature branch — a PR change)

The lock `examples/starters-lock.json` must hold the version before it can be published.

```sh
PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"
node scripts/publish-starters.mjs --stage                 # the pinned version, from HEAD
node scripts/publish-starters.mjs --stage --ref=<sha>     # an OLDER version, from that commit with its own builder
```

`--stage` refuses a dirty tree (other than the lock itself), a version already on the registry, an unreachable registry, and an entry the lock marks published. Commit the lock; `check-starters-pin` (root `check-host-kit`) now holds `examples/` to it.

## Publish (from merged `main`)

1. A clean checkout at `origin/main` — in a worktree: `git fetch origin && git switch --detach origin/main`. Copy the gitignored `scripts/check-public-scrub.mjs`, `check-public-scrub.test.mjs` and `scrub-tokens.json` into its `scripts/` (the publish refuses without the scrub).
2. `pnpm install --frozen-lockfile`, then the dry run: `node scripts/publish-starters.mjs --version=<v>` (default: the pin). Read the printout: ref, node/npm versions, npm user, tarball + integrity, scrub OK, the publish line.
3. `node scripts/publish-starters.mjs --publish --version=<v> --otp=<code>` (or omit `--otp` in your own terminal and answer the prompt). Publish **oldest first** (`0.1.0`, then `0.1.1`) so `latest` lands on the pin.
4. The script verifies the registry integrity and every wrapper on jsDelivr, then marks the lock entry `published` with its integrity. jsDelivr can lag minutes: NOT VERIFIED there is not a failure — re-check with `node scripts/check-starters-pin.mjs --online`.
5. Commit the lock change on a branch → PR → merge. Journal: what, the UTC time, the integrity, both verification results.

## After the first publish

- `npm access set mfa=publish @snugprotocol/starters` (every future publish needs 2FA, no automation tokens), and turn on "Require 2FA" for the org. Journal both.
- Refresh what was built before: your installed Claude Code plugin keeps the kit it was installed with (uninstall + reinstall from a fresh `node scripts/build-plugin.mjs` build, since the plugin version does not change); republish any private walk artifact from a fresh kit if you want it on the new pin. Kits that baked `0.1.0` work as they are — `0.1.0` IS their bytes.
- Then: open a kit page → the shelf → Chess → install.

## When the gate goes red

`check-starters-pin: FAILED — … no longer match the staged (unpublished) X` → run `--stage` and commit. `… no longer match the PUBLISHED X` → bump `version` in `examples/starters-package.json`, run `--stage`, commit. Never edit the lock by hand.

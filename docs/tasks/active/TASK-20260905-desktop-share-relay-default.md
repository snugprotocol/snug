# TASK-20260905-desktop-share-relay-default: the desktop shell knows the share relay by default

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: medium (`apps/desktop` build config; no Rust, no IPC)
- **Branch**: `feat/TASK-20260905-desktop-share-relay-default` (cut from `main` @ `f21120d`)
- **Packages touched**: `apps/desktop` (Medium), `scripts/release-desktop.mjs` (re-export only)
- **Spec impact**: none
- **Related**: TASK-20260904-share-link-ux (PR #166 — the release-script pin), ADR-0064 amendment 2026-09-04

## Spec (what & why)

After #166 the owner reported: "sharing on playground works as expected. the desktop doesn't show the share/copy button at all, just download." Cause: `SHARE_RELAY_ORIGIN` is a build-time `VITE_SNUG_SHARE_RELAY`; #166 pinned it in `release-desktop.mjs`'s `tauri build` environment ONLY, so `tauri dev` (no `apps/desktop/.env*`, by design) and the installed v0.1.2 (built before the pin) both render no link action. The desktop shell is Snug's own binary — there is no self-hosted desktop — so the relay is a property of the shell, not of whoever runs the build.

**Acceptance criteria**
1. `apps/desktop/vite.config.ts` defaults `VITE_SNUG_SHARE_RELAY` to `https://share.snugprotocol.org` when the environment has none, so `tauri dev` and `tauri build` both bake it in; an explicit value in the environment still wins (dev against a dev relay). Pinned by a test that resolves the real Vite config (`resolveConfig`) and reads `config.env`, with and without the variable set — and asserts equality with `release-desktop.mjs`'s `SHARE_RELAY_ORIGIN` (one constant across web deploy, desktop release and desktop dev).
2. `release-desktop.mjs` still refuses a DIFFERENT relay in the environment (unchanged; the default and the pin agree by the test above).

**Out of scope**: cutting v0.1.3 (an explicit-ask release; the installed app gets this with the next release).

## Plan
Test first in `apps/desktop/src/__tests__/shareRelayDefault.test.ts` → the config change → `pnpm --filter desktop test` → docs (runbook one line, code-map row, next-steps).

## Session journal (append-only, newest last)

### 2026-09-05 01:10Z — Claude (Fable 5.1) — session
- Done: diagnosis above; branch; this file.
- Next step: the test, red, then the config.
- Done: `shareRelayDefault.test.ts` (2, `@vitest-environment node` — Vite's `resolveConfig` runs esbuild, which refuses jsdom's `TextEncoder`) red → `vite.config.ts` `process.env.VITE_SNUG_SHARE_RELAY ??= DESKTOP_SHARE_RELAY_DEFAULT` (Vite folds VITE_* `process.env` into `import.meta.env` when it loads env AFTER the config file — the second test proved the mechanism before the first went green) → green; `release-desktop.mjs` re-exports `SHARE_RELAY_ORIGIN` (+ `.d.mts`) so the test pins ONE constant. `pnpm --filter desktop test` 194/194; release-desktop tests 22/22; a real `vite build` of the desktop carries `share.snugprotocol.org` in its bundle (grep, 1 chunk).
- State: in-review. **The installed v0.1.2 cannot show the link actions until v0.1.3 ships (explicit-ask release); `tauri dev` shows them after a restart.**
- Next step: PR → CI → owner merge; v0.1.3 when the owner says so (then the `snug://` walk).

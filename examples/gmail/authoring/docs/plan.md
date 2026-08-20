# Plan — Inbox Copilot

Built in three slices, tests first (repo Gate 3).

## Slice A — the registry pin (`packages/auth`)

Gmail was resolvable but not connectable: right endpoints and hosts, but no scopes (a
token that reads nothing) and no credential fields (a wizard screen with zero inputs).

1. RED: scope-set assertions, the negative on `https://mail.google.com/`, field and
   walkthrough assertions, and the roster update in `well-known-providers.test.ts`.
2. **Probe before pinning copy.** Google's native-app docs list `client_secret` as
   Optional; the token endpoint refuses a Desktop-client exchange without it. Pin both
   fields and never write "no secret needed".
3. Pin `scopes`, `fields`, `registration`; amend ADR-0028's roster.

## Slice B — the app (`examples/gmail/`)

4. RED: `gmail-analysis.test.mjs` against the marker-delimited pure core — and wire it
   into `examples/package.json`'s test script in the same step, because that script
   enumerates suites explicitly and an unlisted file never runs.
5. Bare `connection.json`; `runtime-contract.json` within the schema's field caps
   (600/400/500/500 chars).
6. `app.html`: hooks block spliced byte-identical from the SDK, then the pure core
   between `GMAIL-CORE` markers, the sample block between `GMAIL-SAMPLE` markers, the
   open-url bridge hand-rolled outside the hooks block, then the four lanes.
7. README + authoring provenance (this set).
8. Pins: `APPS`, `CONNECTED_APPS`, `MANIFEST_APPS`, `P4_STARTER_FOLDERS`, `SAMPLE_APPS`.

## Slice C — the shelf

9. `STARTER_LOOKS` row in `HubView.tsx`: display name "Inbox Copilot", unique emoji,
   `desktopOnly` — a Desktop-app OAuth client registers loopback redirects only, so the
   web playground origin cannot serve this flow.

## Verification

`pnpm --filter examples test`, `pnpm --filter @snugprotocol/auth test`,
`pnpm --filter playground test`, then root `pnpm test` — `packages/auth` is widely
depended on even for a data-only change.

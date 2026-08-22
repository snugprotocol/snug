---
title: Host a hub client
description: Build a full Snug host — the surfaces to implement, the order that works, and how to prove conformance as you go.
sidebar:
  order: 1
---

A **hub client** is a full host: it owns a user file, renders apps in the sandbox, brokers
every capability, and gives the user a place to build. The reference Playground and the
macOS desktop shell are both hub clients over the same packages — this guide is the map for
building yours, whether you reuse those packages or implement the spec in another stack.

## Build order that works

Each stage below is independently testable, and the stages are ordered so you always have
something running.

### 1. Mount and handshake

Render an app iframe with `sandbox="allow-scripts"` and **no network** (blocked
`connect-src`), then speak the handshake: send `snug:host-ready` with your capability flags,
accept `snug:app-announce`. Validate every inbound frame at the boundary against the
[published schemas](/docs/spec/schemas/) — malformed frames are refused, not repaired.

A host at this stage can already run any LLM-optional app.

### 2. The agent bridge

Implement `snug:app-message` → `snug:app-response`: route the app's action to whatever agent
you host, stream cumulative text if you advertise `streaming`, and honor `snug:app-cancel`.
How you assemble the agent's context is Part IV's subject — start naive, then adopt
[runtime contracts](/docs/concepts/runtime-contracts/) before your turns get expensive.

### 3. The user file

Implement [Part II](/docs/spec/part-2-the-portable-user-database/): one SQLite file per
user, the hub-namespace tables with their normative DDL, per-app native tables materialized
into an isolated runtime database at load. Then prove the property that matters: **export a
file, wipe your host, import it, and everything still runs.** If that round-trip holds,
your users own their data in fact rather than in copy.

### 4. Storage frames

`snug:db-request` / `snug:db-response` against the app's own tables. Failures are typed and
honest; a write the user would care about is a write your UI can show.

### 5. Connections (only when you need them)

[Part III](/docs/spec/part-3-connected-apps/) is the largest surface and the most
security-sensitive: requirements, user approval, credential custody in the user's file, and
the host executor with its frozen ceiling. Read
[the concept page](/docs/concepts/connections/) first, then implement against the spec text —
and keep its two constants sacred: credentials never enter the iframe, and injection has no
lenient mode.

## Conformance as you go

[Part VI](/docs/spec/part-6-conformance/) states the normative requirements;
[Appendix A](/docs/spec/appendices/) is the error-code registry and
[Appendix B](/docs/spec/appendices/) the constants (frame size classes among them). Three
habits from the reference implementation worth copying:

- **Test the refusals, not just the accepts** — and pair every "X cannot reach Y" test with
  a positive twin proving the legitimate caller still can.
- **Validate at the envelope boundary**, everywhere, so a hostile app or a hostile file
  meets the same wall.
- **The sandbox flags are load-bearing.** `allow-scripts` disables entire DOM behaviors
  (form submission among them) — enumerate what your CSP and sandbox actually enforce and
  probe them in a real browser, because jsdom will lie to you.

## Reuse what's shippable

All of this exists as MIT packages if your stack is TypeScript:
`@snugprotocol/runner` (stage 1), `@snugprotocol/protocol` (validation),
`@snugprotocol/db` (stages 3–4), `@snugprotocol/auth` (stage 5), with
[`apps/playground`](https://github.com/snugprotocol/snug) as the worked assembly. A
non-TypeScript host implements the same spec — the schemas and Part VI are the contract,
not the packages.

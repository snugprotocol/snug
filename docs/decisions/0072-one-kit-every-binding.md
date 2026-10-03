# 0072 — One kit, every binding: a single page, a capability-true shelf, and the chat delivery

- **Status:** accepted (owner-delegated, 2026-10-03: Q4, Q5, Q6 and Q7 of the task file are the defaults taken here, each reversible by one word)
- **Date:** 2026-10-03
- **Task:** TASK-20261003-host-bindings-complete
- **Amends:** ADR-0068 §1 / D-B1 (the second build of the kit is withdrawn) · ADR-0065 §2 A2 (the chat delivery is built) and §3 (what a binding without connections does with a connected app) · ADR-0066 A8 (the chat brain is budgeted) · ADR-0021 D9 (the platform seam gains the availability derivation)

## Context

The owner's direction (2026-10-03): the bindings must not grow their own copies of the runner — "like how the web and desktop today share the same runner code" — and a host must not offer an app it cannot run.

Read from the code on 2026-10-03:

- `apps/host` is built twice. `vite.local.config.ts` is a restatement of `vite.config.ts` differing in the entry, the file name and the output directory; `local.html` differs from `index.html` in one line; the two pages are **the same size** (measured 2026-09-07 — connections are a runtime flag, not a build exclusion); the plugin ships both (4.5 MB). The "binding" is decided at build time for one page and at runtime for the other, and `local-host` means two different things (a runner, or any loopback static server), which makes the custody chip wrong in the second case.
- The capability block is hand-written four times; the custody store, the hand-in summary and three small helpers exist twice; Binding B's hand-in path dispatches three DOM events nobody listens to, so an app the agent hands in does not appear until a reload and its note never reaches the user.
- The only gate on a starter is a `desktopOnly` flag in a UI table, tested against `kind !== 'desktop'`. Its one reason string is true for one of the three starters it locks; it is wrong under Binding B, where a Node process, not a browser, carries the request; installed apps and the run route have no gate at all. Under an artifact a connected starter is enabled and described as running "in its sample mode", which is false for at least one of them.
- The chat binding (A2) has never run where it is meant to: the kit reads `sessionStorage` unguarded (it throws at an opaque origin), the chat brain has no prompt cap, no timeout and a ruler that under-counts a conversation, the skill has no chat recipe, and the delivery was never built. Its cap can only be measured inside claude.ai, by a person.

Measured on the real viewers (T1, 2026-09-05): a chat artifact is an `about:srcdoc` page at origin `null`; `window.claude` is `{ complete }`; scripts load from jsDelivr `/npm/` and cdnjs only; `window.storage` is per view; export is copy-as-text. Read from the plugin documentation (2026-10-03): a plugin's skills load in chat, Cowork and Claude Code; its local server runs in Claude Code and in Cowork sessions on the person's computer and is ignored in chat; a plugin is added to chat and Cowork by uploading a zip or adding a marketplace.

## Decision

1. **One page.** `apps/host` has one Vite config, one html entry and one output, `snug-host.html`. It is the artifact page, the chat page, the plain file and the page the local host process serves. The plugin ships it once. A structural test fails on a second config or entry.

2. **The binding is a runtime fact, decided once.** At boot the page claims a launch token if the address carries one, and on a loopback origin asks its own origin for `/status`. A runner that answers makes the binding `local-host` and composes the local platform (the process's seams); a runner that refuses for want of a token is the "open it from your agent" refusal; anything else is what the probe finds — an artifact, a chat, a static page. `local-host` therefore means one thing.

3. **One of everything the bindings share.** One boot path; one capability table (`hostCapabilities()` — no capability literal elsewhere, by a lint); one custody store; one hand-in core that serves the page's embedded blocks (A) and the runner's events (B), so Binding B gains the pending-update offer, the live hub and the note; one guarded accessor for storage globals; one sentence for "connections are not available here". Host-to-UI signals are stores the UI subscribes to, never DOM events.

4. **A host offers only what it can run.** `platform/availability.ts` is the one derivation: what an app NEEDS (from its declared connection requirement, or an installed app's connection rows — the network, a provider no browser can call, OAuth, a device on the LAN, the linked-device helper) against what the host OFFERS (read from the platform's seats, never from `kind`). A starter or an installed app the host cannot run is **disabled**, on the shelf and on its route, with the true reason and where it does run. The `desktopOnly` flag is deleted; the wizard's walls and the browser-wall disclosure read the same derivation. This supersedes ADR-0065 §3's "connected starters run their sample mode": a preview that cannot do the one thing the app is for teaches the wrong thing about it.

5. **The chat brain is measured, not assumed.** The `complete` adapter is raced against the caller's abort and a named wall-clock bound; its ruler is the string it sends. Its prompt cap starts at a pinned conservative default, is lowered by a failure in the size class and raised only by a proven success, is kept per view, and is read per call, so the builder budgets or refuses on it (ADR-0066's ladder now covers this brain). An explicit, disclosed, cancellable **measure** act on the chip runs a ladder of probe calls — it spends the viewer's usage, so it is never run on load — and a copyable report carries the numbers. The owner's walk is one paste and one click; the product does not depend on it having happened.

6. **The chat delivery is two routes from one build.** `snug-host.js` is derived from `snug-host.html` (the same module, the page's style, self-mounting) and laid out as `@snugprotocol/host` for jsDelivr `/npm/`; a generated bootstrap of at most sixty lines loads it at an exact version with `integrity`. Where the chat can present a file, the skill instead writes the whole page with the app embedded and needs no CDN at all. The skill carries both, the scripts do every escape, and the package is validated by `npm pack --dry-run` — **registering the scope and publishing remain owner acts**.

7. **Claude Desktop is three surfaces, served by one plugin.** The Cowork tab and the Code tab start the plugin's local runner (Binding B); the chat tab loads only the plugin's skill, which takes the chat route (A2). A `.mcpb` extension is not built: it would be a second distribution of the same process for a surface the directory no longer lists.

## Alternatives considered

- **Keep two builds and share a config factory.** Rejected: it removes the restated config and keeps the second artifact, the second gate target, the second copy in the plugin and the build-time binding.
- **A capability flag per starter in its manifest.** Rejected: a starter already declares what it needs (`connection.json`), and an installed app has its rows; a second declaration is a second source of truth, and it could not cover apps the user built.
- **Leave connected starters enabled in sample mode.** Rejected by the owner's item 5, and by `weather`, which has no sample mode.
- **Pin the chat cap at a number.** Rejected: nobody has measured one, the number belongs to a runtime Snug does not control, and ADR-0069's `outdated` state is the record of what a pinned assumption about someone else's limit costs.
- **Have Claude hand-type the app into the bootstrap.** Rejected: a skill in chat has a code sandbox, and an LLM escaping thirty kilobytes of HTML into JSON is the failure mode the scripts exist to remove.

## Consequences

- Positive: one artifact to build, gate, ship and reason about; the plugin halves; Binding B's hand-in works as Binding A's does; every "cannot run here" has a reason; the chat binding fails by name instead of hanging or cutting.
- Negative / residuals: the artifact page now carries the local composition as live code (it always carried its bytes) — reachable only from a loopback origin whose own server answers `/status`; a connected starter can no longer be previewed where it cannot connect; the chat walk (the cap's real number, `RUNNER_CSP` inside the chat frame, storage before publish) is still a person's to do, and until the npm publish only the file route can deliver the kit in chat; ADR-0068's "the kit twins stay honest" consequence is withdrawn with the twin.
- Docs owed (this task): architecture ("Host kit", "The local host process", the dependency graph), code-map, glossary ("availability", "host passport"), ADR-0065/0068 status lines, the threat-model delta (the one page; the chat brain's measure act), next-steps.

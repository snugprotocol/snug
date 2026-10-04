# 0072 — One kit, every binding: a single page, a capability-true shelf, and the chat delivery

- **Status:** accepted (owner-delegated, 2026-10-03: Q4, Q5, Q6 and Q7 of the task file are the defaults taken here, each reversible by one word) — **amended 2026-10-04** (TASK-20261003-host-bindings-complete): §1–§4 are built and §7 stands (no `.mcpb`; the chat tab takes the artifact runner); **§5 (the chat brain, the learned cap, the measure act, `PromptBudgetSeat`) and §6 (the chat delivery: the script build, the npm layout, the bootstrap) are WITHDRAWN** — the owner's measurement of 2026-10-03 found the chat runtime is the hosted runtime — and Q6 is withdrawn with them; §2's router wording is corrected. See the amendment at the end.
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

2. **The binding is a runtime fact, decided once.** The boot's first branch is the OAuth callback document (`/oauth/callback` → the callback page alone; under the kit's hash router that document rendered the hub, so a Binding-B OAuth could never complete). Then, ONLY at the literal origin `http://127.0.0.1:<port>` — never `localhost`, another address, `https:` or `file:` — the page claims a launch token if the address carries one and asks its own origin for `/status`. A runner that answers with the pinned shape makes the binding `local-host` and composes the local platform; a refusal carrying the runner's constant marker header is the "open it from your agent" page; anything else is what the probe finds — an artifact, a chat, a static page. `local-host` therefore means one thing. Under `local-host` the page reads no embedded bundle or `snug-db` block (hand-ins arrive by runner events), and the process serves only bytes whose hash was pinned when the plugin was built. The router is chosen by capability: where the History API refuses a hash URL (an opaque `about:srcdoc` document — every chat artifact) the kit mounts a memory router.

3. **One of everything the bindings share.** One boot path; one capability table (`hostCapabilities()` — no capability literal elsewhere, by a lint); one custody store; one hand-in core that serves the page's embedded blocks (A) and the runner's events (B), so Binding B gains the pending-update offer, the live hub and the note; one guarded accessor for storage globals; one sentence for "connections are not available here". Host-to-UI signals are stores the UI subscribes to, never DOM events.

4. **A host offers only what it can run.** `platform/availability.ts` is the one derivation: what an app NEEDS (from its declared connection requirement, or an installed app's `declared`/`approved` connection rows — the network, a provider no browser can call, OAuth, a device on the LAN, the linked-device helper) against what the host OFFERS (read from seats the platform already carries — `fetchImpl`, the LAN pair, the sidecar seats, the connections surface — never from `kind` and never from a new flag a shell could forget to set). A starter or an installed app the host cannot run is **disabled**, on the shelf and on its route (the route keeps its header, so a blocked app can still be exported), with the true reason and where it does run. This gates installed apps on web and desktop too (ADR-0023 D1's disclose-in-the-wizard posture is unchanged for rows; the tile and the route are new). The web shelf's `desktop` badge is unchanged. The `desktopOnly` flag is deleted; the wizard's walls and the browser-wall disclosure read the same derivation. This supersedes ADR-0065 §3's "connected starters run their sample mode": a preview that cannot do the one thing the app is for teaches the wrong thing about it.

5. **The chat brain is measured, not assumed.** The `complete` adapter is raced against the caller's abort and a named wall-clock bound; its ruler is the string it sends. Its prompt cap starts at exactly 65,536 bytes — the value at which the builder still carries its knowledge base (ADR-0066), labelled "assumed, not measured here" — is lowered only by a rejection of a prompt larger than the largest proven success (never by an abort, a timeout or a rate limit, and never by an app's own thinks), is kept per view, and is read per call, so the builder budgets or refuses on it and its knowledge delivery follows the cap within the session (ADR-0066 decision 1's "never changes mid-session" is amended for this brain). An explicit, disclosed, cancellable **measure** act on the chip runs a fixed ladder of probe calls with head and tail markers, so a silently truncated prompt is seen — it spends the viewer's usage, so it is never run on load — and a copyable, value-free report carries the numbers. The owner's walk is one paste and one click; the product does not depend on it having happened.

6. **The chat delivery is two routes from one build, and neither is verified until a person walks it.** `snug-host.js` is an ES module derived from `snug-host.html` (a pinned preamble, then the page's module bytes unchanged) and laid out as `@snugprotocol/host` for jsDelivr `/npm/`; a generated bootstrap shell of at most 4 KB loads it at an exact version with `integrity`. Where the chat has a file-presenting tool, the skill instead writes the whole page with the app embedded and needs no CDN — a route nobody has yet observed rendering with `complete` and `storage`. The skill chooses by the tools present, the scripts do every escape, the bootstrap is not emitted before a published version exists, and both packages (`host`, `starters`) are validated by `npm pack --dry-run` — **registering the scope and publishing remain owner acts**.

7. **Claude Desktop is three surfaces, served by one plugin** (per the plugin documentation, read 2026-10-03; the Cowork tab is not yet walked). The Cowork tab and the Code tab start the plugin's local runner (Binding B); the chat tab loads only the plugin's skill, which takes the chat route (A2). A `.mcpb` extension is not built: it would be a second distribution of the same process for a surface the directory no longer lists.

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

## Amendment (2026-10-04, TASK-20261003-host-bindings-complete)

**What changed the decision.** On 2026-10-03 the owner ran a probe in claude.ai (Chrome) three
times. A chat artifact no longer runs where T1 measured it in September: it is served from a real
`https://<id>.frame.claudeusercontent.com` origin, `window.claude` is `{ use, hot }` with no
`complete`, there is no `window.storage`, the History API and browser storage work, and a
chat-created artifact declared with capabilities resolves `sample`, `artifact` and `downloads`.
Read back through the Artifact tool, a chat-created artifact is stored exactly as a tool-published
one — the contract-0.2.67 skeleton (536 bytes through `<body>`) around the page. `sample.limits()`
answered `{ maxPromptBytes: 262144, tools: { maxCount: 16 } }`, and the cap was confirmed
inclusive at exactly 262,144 bytes. The nested `sandbox="allow-scripts"` frame inside a chat
artifact is at origin `null`, its `fetch` is blocked by CSP and `parent.document` throws — C2
holds there, measured. So the chat binding is the hosted runtime, and Binding A2 is A1's code
path.

- **§5 is WITHDRAWN.** Nothing it describes exists in the code: no `complete` adapter, no learned
  cap, no measure act, no `PromptBudgetSeat` (added by the task's contracts commit and removed in
  the same task). The `complete` adapter (`brains/complete.ts`), the `window-storage` backend
  (`storage/windowStorage.ts`) and the `artifact-chat` binding were deleted; the bindings are
  `artifact`, `artifact-static`, `local-host` and `file` (`apps/host/src/probe.ts`). A page that
  meets only `window.claude.complete` is composed like any page with no host brain, and the demo
  brain answers. `sample`'s cap is read from `limits().maxPromptBytes` at boot; 65,536 is kept only
  as the fallback for a `limits()` that rejects (`DEFAULT_MAX_PROMPT_BYTES`,
  `apps/host/src/brains/prompt.ts`). Every `SampleErrorCode` of contract 0.2.67 (19) maps to a
  named result; nothing retries by itself. Q6 is withdrawn with §5.
- **§6 is WITHDRAWN.** No `snug-host.js`, no npm layout for `@snugprotocol/host`, no bootstrap.
  Chat takes the artifact runner, as every other surface with an `Artifact` tool does: the skill
  publishes its own `assets/snug-host.html` BY FILE, private, titled `Snug`, with
  `{ sample, artifact, downloads }`, and hands apps in with `scripts/snug-embed.mjs` and a
  republish (`packages/knowledge/prompts/skills/snug/SKILL.md`). The save stays a BARE full
  document: contract 0.2.67's `artifact.d.ts` asks for the complete replacement page starting
  with `<!doctype html>`; `unwrapViewerPage` (`scripts/lib/page-blocks.mjs`) reads the 0.2.67
  skeleton around the kit page and still refuses any other shape by name. Not yet observed:
  whether chat-Claude, with the plugin's skill loaded, can reach the asset file and publish it —
  the owner's walk ([runbook](../runbooks/owner-walks-host-bindings.md), track B). If it cannot,
  the delivery question is its own task (`docs/next-steps.md`, 2026-10-04), not this ADR.
- **§2's router sentence is corrected.** It said the History API "refuses a hash URL" in "an
  opaque `about:srcdoc` document — every chat artifact". Two corrections: react-router's
  `HashRouter` does not throw when `pushState` is refused — it falls back to `location.assign`, a
  navigation of the document rather than a route change; and chat artifacts are no longer such
  documents. The memory-router decision stands, for any document where it holds: the kit tries
  `history.replaceState` with the current fragment once, and mounts a `MemoryRouter` seeded from
  `location.hash` only where that throws (`apps/host/src/router.tsx`). §2's "an artifact, a chat,
  a static page" reads "an artifact or a static page" — there is no separate chat binding.
- **§7's chat tab** loads the plugin's skill, which takes the artifact-runner recipe above — not a
  separate A2 route.
- **The Amends line, read now.** "ADR-0065 §2 A2 (the chat delivery is built)" and "ADR-0066 A8
  (the chat brain is budgeted)" did not happen; ADR-0065 and ADR-0066 carry their own 2026-10-04
  amendments saying what did.
- **What §1–§4 built.** One page (`apps/host/vite.config.ts` → `snug-host.html`; the process finds
  it through `apps/host-mcp/src/page.ts`, pinned by sha256); one boot (`mountKit`,
  `apps/host/src/boot.tsx`) whose first branch is the `/oauth/callback` document; the runner path
  tried only at the literal `http://127.0.0.1`; one capability table (`hostCapabilities()`,
  `apps/playground/src/platform/hostCapabilities.ts`); one guarded accessor for storage globals
  (`apps/host/src/safeStorage.ts`); one hand-in core for both bindings (`applyAgentBundles`,
  `apps/host/src/handin.ts`), with `snug_hand_in` answering what the page did; host-to-UI signals
  as stores (`apps/playground/src/platform/signals.ts`); and the availability derivation
  (`apps/playground/src/platform/availability.ts`) behind the shelf, the run route, the wizard's
  walls and the host passport (`apps/playground/src/views/HostPassport.tsx`).

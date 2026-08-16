# TASK-20260816-whatsapp-twin: WhatsApp thread companion — persona analysis + mimic replies

- **Status**: planned (awaiting owner plan approval — Gate 2 STOP)
- **Owner**: jeetu
- **Risk tier**: **High** (touches `packages/protocol` connection-requirement schema, `packages/auth` registry/admission/executor, a new Tauri IPC command — auto-escalate per PROCESS.md; full TDD + negative tests + fresh-context AI plan review before implementation + journal self-sign-off)
- **Branch**: `feat/TASK-20260816-whatsapp-twin` (created off `main` @ 5825fb7)
- **Packages touched**: `protocol`, `auth`, `playground`, `desktop`, NEW `apps/whatsapp-sidecar`, `examples/` (+ dependents: protocol change → run everything, root `turbo run test --force`)
- **Spec impact**: internal draft (connection-requirement is NOT in `schemas/` sources — same class as lanHost/ADR-0023): staged draft note + spec-changelog entry per SPEC_SYNC
- **Related**: ADR-0016 (trust ladder), ADR-0020 (auth kinds), ADR-0021 D4 (private-literal transport), ADR-0023/0025 (LAN class, pairing verify-before-claim), ADR-0026 (connection-relative addressing), ADR-0031 (write posture, provider lane); NEW ADR-0032 + ADR-0033 (drafted with this task); open-thread "BYOK CORS sidecar relay (not commissioned)" — this task builds the first real sidecar precedent

## Spec (what & why)

A benchmark-setting connected starter, **"Twin"** (`examples/whatsapp/`): the user links their
**personal** WhatsApp as a linked device (Baileys, via a local sidecar), picks ONE thread
(group or DM), and the app:

1. **Ingests history** — sidecar history-sync pages plus an optional uploaded WhatsApp
   `Export chat` .txt file — and deep-analyzes it via LLM (host-governed turns only).
2. **Builds per-thread persona memory** in the app DB: the user's own voice (tone, vocabulary
   fingerprint, emoji signature, humor style, usual response language) as a mimic profile,
   plus a psychologist-grade profile of every participant and the group/relationship dynamics.
3. **Answers questions** in the app chat lane (most fun / most emotional / most active,
   member dynamics) — the existing intent-routed data lane reads the stored analysis rows.
4. **Replies as the user**: manual **Reply** = mimic draft + one-tap confirm send;
   **Auto-reply** = unattended sends while ARMED (group: only when the user is tagged;
   DM: every new message), governed by ADR-0033 (scope frozen at arm time, rate cap,
   quiet hours, kill switch). Replies always go out in the language the user usually
   responds in for that thread (from the mimic profile), regardless of UI language.
5. **Inline translate**: every received message whose detected language differs from the
   app's default language (setting; default English) shows a translate icon; tap → LLM
   translation into the default language, cached per message in the app DB.

**Why**: demonstrates the protocol's reach — a live, personal, always-on-feeling companion no
gatekept app store would ship, with C1/C2 intact. Also lands the first first-class
`linked_device` auth kind + the registry entry, so every future user-authored WhatsApp app
gets the same consistent auth wizard (owner ask, 2026-08-16).

**Owner decisions from the Gate-1 interview (2026-08-16):**
- One task, full vision (High tier).
- Sidecar = repo package `apps/whatsapp-sidecar` (Node + Baileys, localhost HTTP), desktop
  shell spawns/supervises it; desktop-only starter (web = disclosure wall like LAN rows).
- Armed auto-reply with standing scoped approval → **ADR-0033** (first standing write approval).
- New first-class **`linked_device`** auth kind in the protocol + registry → **ADR-0032**
  (spec-sync; admission stays kind-agnostic per the D6 pin).
- (mid-session additions) Registry entry explicitly requested; inline translate feature;
  reply language = user's observed response language.

**Plan-level decisions (recorded, approval = ratification):**
- **The sidecar is LLM-free.** Every analysis/mimic/translate turn runs in the governed host
  (invariant: LLM calls originate from the host page only). Consequence: auto-reply is active
  while the app is open in the desktop hub. Rejected alternative: sidecar holds its own LLM
  key and replies autonomously — a second, ungoverned brain outside C1's wall.
- **Credential custody split**: WhatsApp session keys (Signal/noise keys) live ONLY in the
  sidecar's disk store and never transit the hub in any response. What lands in
  `snug_secrets` is a **sidecar access token** minted once at pairing (Hue-parallel:
  exchange → minted secret → header injection). C1 story stays clean.
- ~~**Loopback host class**: new `lanHost` class `'loopback-ipv4-literal'`; executor
  `transportPolicy` gains a desktop-only loopback allowance.~~ **WITHDRAWN at Gate 2 —
  see BLOCKER B1 below.** Replaced by a dedicated Rust command (`sidecar_fetch`).
- **ToS honesty**: unofficial WhatsApp automation violates WhatsApp ToS; ban risk is real.
  Disclosure is mandatory in the wizard consent copy AND the starter README; the sidecar
  applies human-like send pacing + the ADR-0033 rate cap as mitigation, never evasion.

**Acceptance criteria** (each becomes at least one test):
1. **Protocol**: `linked_device` kind + `lanHost` class `'loopback-ipv4-literal'` parse and
   validate; declaredApiHosts-XOR-lanHost holds; class rules refuse non-loopback literals,
   DNS names, IPv6; spec-changelog + staged draft updated.
2. **Registry**: `whatsapp-personal` entry (kind `linked_device`, loopback seat, pairing
   seats: start/qr/status/verify, `headerTemplate` for the sidecar token) emits through
   `requirementFromRegistryEntry`; structural suites (`static-kind-registry`,
   `registry-self-containment`) extended; admission preserves the declaration's loopback
   host on borrow and refuses a public host smuggled under the entry (ADR-0023 §1 parallel).
3. **Executor**: http-to-loopback admitted ONLY via desktop `transportPolicy` for the
   approved frozen ceiling; browser profile byte-identical when absent (negative);
   credential-header strip, 1 MiB cap, mutating-confirm gate all fire unchanged on the
   loopback path.
4. **Wizard**: full linked_device journey — review (with ToS disclosure copy) → loopback
   collect/confirm → approve/freeze → pair (QR rendered from sidecar, poll to linked, token
   → `snug_secrets`) → verify-before-claim (ADR-0025 pattern: `GET /session/status` with the
   just-minted token before any connected claim) → done; web shows the desktop-only
   disclosure wall; pairing-abandon and sidecar-unreachable paths surface named errors.
5. **Sidecar**: pairing mints the access token exactly once; every non-pair route 401s
   without it; server binds 127.0.0.1 only (never 0.0.0.0); chats/history/messages/send
   endpoints are thread-scoped; responses ≤ net-frame size class; **no route ever
   serializes WhatsApp session key material** (negative test over every route with a
   populated real-shaped auth store).
6. **Starter**: `examples/whatsapp/` installs from the shelf (11th app), declares via
   `connection.json` (install-act rung), ships `runtime-contract.json` + `authoring/`
   provenance bundle; `validate.test.mjs` APPS/folder parity + LLM-posture + no-form rules
   green.
7. **Analysis**: export-.txt parser handles real WhatsApp export shapes (DM + group,
   multiline, media-omitted lines); history + export merge dedups; persona/member/dynamics
   rows land in app DB per thread; chat-lane sample questions answer from those rows.
8. **Reply surfaces**: Reply = draft in the user's voice + one-tap confirm before send;
   Auto-reply sends ONLY while armed; arm freezes scope (group tagged-only / DM all),
   rate cap enforced, kill switch disarms immediately; every send goes through the
   connected-fetch mutating gate (armed = ADR-0033 standing scope, not a gate bypass);
   outgoing drafts are composed in the thread's observed user-response language.
9. **Translate**: received messages in a non-default language render the translate control
   (default-language messages must NOT — negative); tap yields an LLM translation into the
   default language, cached in the app DB; default language changeable in app settings.
10. **Desktop spawn**: shell command starts/supervises the sidecar; the new IPC command
    joins the C2 gate scope (IPC-unreachability-from-iframe check added); macOS gate green,
    Windows leg stays deliberately red (ADR-0021 D8 unchanged).
11. **Disclosures & data dignity**: ToS/ban-risk copy pinned in wizard + README; per-thread
    persona data has a visible "forget this thread" deletion affordance that cascades.

**Out of scope**: media/voice messages (text-only v1); multiple simultaneously-armed threads
(one thread armed at a time); auto-reply while the hub app is closed (needs the ungoverned-
brain alternative — rejected); browser live path (disclosure wall); subscription mode
(byok/local only, ADR-0031 gap family); WhatsApp Business API; sidecar binary bundling
(v1 spawns system `node`, documented requirement); mDNS/auto-discovery (loopback is fixed).

## Plan

**Order** (tests FIRST within each phase; each phase is a reviewable commit chain):

- **Phase A — protocol** (`packages/protocol/src/connection-requirement.ts` + tests beside
  `connection-lan-host.test`): add kind `linked_device` to the kind enum; extend `lanHost`
  class union with `'loopback-ipv4-literal'` + literal validator (RESTATED per the ADR-0023
  precedent — auth→protocol cycle); spec-changelog entry + SPEC_SYNC staged-draft note.
- **Phase B — auth** (`well-known-providers.ts`, `requirement-admission.ts`,
  `net-guards.ts`, `connected-fetch.ts` + suites): `whatsapp-personal` entry with pairing
  seats (QR start/poll/verify — modeled on the hue pairing seat family, ADR-0023 §2 +
  ADR-0025 verify); admission fork honors the new class on every channel; transportPolicy
  loopback allowance (desktop-only, class-keyed); executor routes loopback over plain
  `fetchImpl` http (NOT `lanFetch` — no TLS pin exists on loopback; scheme-axis note from
  the code-map LAN row applies). Negative tests per AC2/AC3.
- **Phase C — sidecar** (NEW `apps/whatsapp-sidecar/`: `src/{server,routes,session,store}.ts`,
  Baileys behind a `WaSocket` seam so tests run against a scripted fake): pair/QR/status,
  token mint + auth middleware, chats list, history pages, since-cursor message poll, send
  with human-like pacing, loopback bind guard. Own vitest suite, tsc-gated like every
  package (AC5). Workspace + turbo wiring; add to root graph.
- **Phase D — wizard** (`state/connectionWizard.ts`, `ConnectionWizardSheet.tsx` + tests):
  linked_device step machine (QR screen + linked-poll reusing the pairing step-machine
  seam ADR-0023 built "provider-agnostically"), ToS consent copy, verify-before-claim
  write (`lanVerifiedAt` pattern), web disclosure wall (AC4).
- **Phase E — starter** (`examples/whatsapp/` app.html single-file + embedded hooks,
  `connection.json`, `runtime-contract.json`, `authoring/` bundle; `starterApps.ts` shelf
  row; validate suites): thread picker → Persona Lab (user voice card, member profiles,
  dynamics map) → Insights (fun/emotional/active + response heatmap) → Reply Desk (Reply /
  Auto-reply arm switch) → per-message translate control + language setting → forget-thread
  affordance. Export-.txt parser lives in the app; analysis prompts ride the runtime
  contract (read `docs/.../prompt-engineering-reference` memory before authoring). Real
  sql.js DDL run once per the 2026-08-15 lesson (AC6/AC7/AC9/AC11).
- **Phase F — armed auto-reply** (`state/net.ts` + `packages/auth/src/session-confirm.ts`
  seam + app-side loop): arming rides a NEW scoped standing approval per ADR-0033 —
  thread-scoped (slot + chat JID), frozen trigger scope, rate cap, quiet hours, kill
  switch; persisted per app; every send still traverses the executor's gate order (AC8).
- **Phase G — desktop spawn** (`apps/desktop/src-tauri`): `sidecar_ctl` command
  (start/stop/status of system-node sidecar), supervision, gate additions (AC10).
- **Phase H — docs close**: ADR-0032/0033 accepted, threat-model delta
  `docs/security/threat-model-delta-whatsapp-sidecar.md` (session-key custody, loopback
  local-process risk → token auth, pairing-window residual, ToS/ban residual,
  impersonation/consent residual), code-map rows, next-steps prune, spec-changelog.

**Cross-package impact**: protocol change → run EVERYTHING (root `turbo run test --force`,
`Cached: 0`); auth → auth + playground (+ desktop); rebuild packages before trusting
dependent suites (2026-08-15 lesson).

**High-tier extras**: fresh-context AI plan review of THIS file before Phase A implementation
(after owner approval); negative tests enumerated in AC2/AC3/AC5/AC9; whole-surface review
at close tracing one datum (the sidecar token) end to end; self-sign-off in the journal.

**Sidecar HTTP contract** (loopback :8787, bearer token except pair; all pinned in
one constants module — 2026-08-03 lesson): `POST /pair/start` · `GET /pair/qr` ·
`GET /pair/status` (→ token once, on link) · `GET /session/status` (verify seat) ·
`GET /chats` · `GET /chats/:jid/history?cursor` (see correction below) ·
`GET /chats/:jid/messages?since` · `POST /chats/:jid/messages`.

**Library verification (2026-08-16, done at Gate 2 — API read from the published tarball,
not from memory):** `baileys` and `@whiskeysockets/baileys` are the same package; `latest`
is `7.0.0-rc14`, `legacy` is `6.7.24`. **Pin `7.0.0-rc14`** despite the RC label: the 6.x
line resolves `libsignal` from a **git URL** (`git+https://github.com/whiskeysockets/libsignal-node.git`),
which is an unpinnable supply-chain and offline-install hazard for this repo; the 7.x line
resolves every dep from the registry. Confirmed API surface: `makeWASocket` default export +
`WASocket` type; `useMultiFileAuthState(folder)` → `{ state, saveCreds }` (THE disk store
holding session keys inside the sidecar per ADR-0032 §2); `ConnectionState.qr?: string`
(QR payload for AC4's wizard screen); `sendMessage(jid, content, options)`; events
`connection.update` · `creds.update` · `messages.upsert` · `messaging-history.set`.

**PLAN CORRECTION (history is push, not pull).** `messaging-history.set` arrives as
server-pushed CHUNKS carrying `progress`/`isLatest`/`syncType`, and `messaging-history.status`
signals `'complete' | 'paused'` with an `explicit` flag (completion can be INFERRED by
timeout, not proven). There is no pullable paged history endpoint to put behind a cursor.
So the sidecar OWNS an ingest buffer: it subscribes on link, accumulates thread-scoped
messages to its own store, and `GET /chats/:jid/history?cursor` pages over THAT store,
returning an explicit `{ complete, explicit, progress }` sync-state alongside the page.
The app must render honest "history still arriving / partial" states rather than treating
the first empty page as "no history" — and this is precisely why the export-.txt upload path
is not a nice-to-have but the reliability backstop (a full analysis must be possible when
history sync stalls). AC7 gains a row: an inferred-completion (`explicit:false`) sync must
be disclosed as partial, never as complete.

## BLOCKER B1 (found at Gate 2, before any implementation) — the loopback ceiling is port-blind

**The withdrawn design would have granted every port on loopback, not one sidecar.**

Evidence, read directly:
- `packages/auth/src/app-host-freeze.ts:33` — `isUrlWithinHosts` matches on
  `new URL(url).hostname`, which **strips the port**; `isHostAllowed` (`:24-27`) compares
  normalized hostnames only. The frozen ceiling is **host-granular, with no port component
  anywhere in it.** So a ceiling containing `127.0.0.1` admits `127.0.0.1:11434` (Ollama),
  `:5432`, any local admin UI, any other sidecar — the whole loopback surface.
- `packages/auth/src/net-guards.ts:87-102` — `isForbiddenNetHost` refuses loopback
  UNCONDITIONALLY and its doc comment names this exact defense: *"an approved ceiling
  containing `127.0.0.1` is still refused at this gate."* The withdrawn plan punched
  through a guard installed against precisely this attack, rather than extending an
  allowance.
- `packages/auth/src/net-guards.ts:112-116` — loopback's exclusion from the RFC-1918
  desktop allowance is documented as DELIBERATE.
- `apps/desktop/src-tauri/src/lanfetch.rs:233-237` — the Rust host-class policy states
  loopback *"is refused because it is not RFC-1918, and so a future change to this policy
  must make its own decision about it, not inherit one meant for 'local'."* This task IS
  that future change; the instruction is to decide explicitly, which is what B1 does.

Note this is the ADR-0023 §1 P0-round-2 failure shape repeating: a host-class fork whose
admission semantics were not derived before the seat was designed.

**Redesign (replaces the withdrawn bullet; ADR-0032 §4 to be rewritten before Phase A):**
The sidecar is reached by a **dedicated Tauri command `sidecar_fetch`**, modeled on
`lan_fetch`'s precedent (enforce in Rust, before a socket opens) — NOT by a general
loopback allowance in the executor:
1. **Host+port pinned in Rust**: `127.0.0.1` and the ONE sidecar port, refusing every other
   port and host — the port granularity the TS ceiling structurally cannot express.
2. **`isForbiddenNetHost` stays untouched.** No loopback carve-out enters the general
   executor path, so the browser profile and every non-sidecar app remain byte-identical,
   and no general-purpose loopback fetch primitive is ever created.
3. **The route surface is the contract**: the command admits only the enumerated sidecar
   paths (`/pair/*`, `/session/status`, `/chats*`), so even a compromised app cannot use it
   as an arbitrary local HTTP client.
4. **The sidecar token remains the authorization boundary** (ADR-0032 §2), now defense in
   depth behind the Rust pin rather than the only wall.
5. Loopback plain-http carries no eavesdropping risk of consequence (the packets never leave
   the host), so http is acceptable here — but ONLY because reachability is pinned in Rust.

Consequences for the plan: Phase A no longer changes the protocol `lanHost` class union
(the `linked_device` KIND is still a protocol change, so the tier and spec-sync step stand);
Phase B no longer touches `net-guards.ts`/`transportPolicy`; Phase G grows the `sidecar_fetch`
command and its cargo tests. **AC3 is REPLACED**: instead of "http-to-loopback admitted via
transportPolicy", it becomes "`sidecar_fetch` refuses every host but `127.0.0.1`, every port
but the pinned one, and every path outside the enumerated contract (negative tests per
class), while `isForbiddenNetHost` still refuses loopback on the general executor path".
An open design question for the fresh-context review: whether the app reaches the sidecar
through the executor at all, or whether `sidecar_fetch` is surfaced as its own platform seam
— the former keeps the confirm/scrub gates, the latter avoids bending a host-ceiling model
that cannot express ports. **Leading answer: keep the executor path** (its confirm gate is
what ADR-0033 arming consults, and its scrub is what protects the LLM reader), with the
ceiling holding the symbolic host and `sidecar_fetch` enforcing the real pin underneath.

## Decisions & surprises

- 2026-08-16: Task opened from owner brief; interview locked scope/runtime/send-posture/auth-kind
  (all four recommendations accepted). Architecture reality check: live linked-device session =
  persistent Node process + WebSocket — structurally outside the iframe and the request/response
  executor; hence the sidecar.
- 2026-08-16: Mid-session owner additions — registry entry for consistent wizard reuse;
  inline translate; reply-language rule.
- 2026-08-16: ADR-0032 + ADR-0033 drafted (status: proposed) with this plan.
- 2026-08-16: **BLOCKER B1** (above) — loopback ceiling is port-blind; design withdrawn and
  replaced before any code was written. Caught by reading `app-host-freeze.ts` rather than
  trusting the plan's own claim about the ceiling.
- 2026-08-16: **B2 — the confirm gate cannot carry ADR-0033's grant as written.**
  `createSessionConfirmGate` (`packages/auth/src/session-confirm.ts:36-55`) keys grants on
  `(appId, normalizedHost, method)` in an in-memory `Set`, and its header comment pins
  "lives in MEMORY only (never persisted — it dies with the page)" as a deliberate property.
  ADR-0033 needs a grant scoped to a THREAD (chat JID) — a concept the gate has no seat for
  — that SURVIVES beyond a page session and carries a rate cap + quiet hours. Every armed
  send is `POST` to the same host, so a `(appId, host, method)` grant cannot distinguish the
  armed thread from any other write: **remembering one send would authorize all of them.**
  Resolution (to be ratified by the fresh-context review): do NOT widen the session gate's
  key. Add a SEPARATE `StandingApprovalGate` consulted before the session gate, keyed on
  (appId, slot, threadJid, trigger scope), persisted with the connection, enforcing cap +
  quiet hours + kill switch, and returning "no opinion" for anything outside its frozen
  scope so the normal confirm still runs. This keeps ADR-0033's "armed is a recorded answer,
  not a bypass" claim structurally true instead of aspirational, and leaves the session
  gate's deliberate memory-only property intact. ADR-0033 §3 to be amended with this shape.
  Note: the executor's confirm gate sees a URL, not a thread — so the standing gate must
  derive the thread from the request (the JID is in the path/body per the sidecar contract),
  and that derivation is itself a security seat needing negative tests (a send whose body
  JID disagrees with its path JID must refuse, never pick one).

## Session journal (append-only, newest last)

### 2026-08-16 — claude — session
- Done: Gate 1 spec + interview; Gate 2 recon (architecture, code-map, lessons, ADR-0016/20/21/23/25/26/31,
  starter layouts, validate gates); plan written; ADR-0032/0033 drafted; branch created.
- State: STOPPED for owner plan approval (Gate 2). No implementation code written.
- Next step: owner approves plan → fresh-context AI plan review (High tier) → Phase A tests.
- Open questions: sidecar port default (8787 proposed); starter display name ("Twin" proposed);
  whether desktop spawn (Phase G) may land in a follow-up PR within the task if the chain grows.

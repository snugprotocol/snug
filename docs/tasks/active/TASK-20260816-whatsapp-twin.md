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
1. **Protocol**: the `linked_device` kind parses and validates, with a pinned
   `declaredApiHosts` (NOT a `lanHost` seat — see BLOCKER B3); every exhaustive
   kind-switch site compiles or fails loud; spec-changelog + staged draft updated.
2. **Registry**: `whatsapp-personal` entry (kind `linked_device`, loopback seat, pairing
   seats: start/qr/status/verify, `headerTemplate` for the sidecar token) emits through
   `requirementFromRegistryEntry`; structural suites (`static-kind-registry`,
   `registry-self-containment`) extended; admission preserves the declaration's loopback
   host on borrow and refuses a public host smuggled under the entry (ADR-0023 §1 parallel).
3. **Reachability (REPLACED per B1/B5)**: `sidecar_fetch` refuses, in Rust before a socket
   opens, every host but `127.0.0.1`, every port but the one `sidecar_ctl` spawned, and
   every path outside the enumerated contract — one negative test per class, each
   red-proven against the naive implementation. `/pair/*` is unreachable from the
   app-facing path (negative). `isForbiddenNetHost` still refuses loopback on the general
   executor path, `transportPolicy` is unchanged, and `netTransportCapability.test.ts`'s
   two-port assertion passes **unmodified** — the capability file gains NO new entry.
   Explicit negative: an app with an approved WhatsApp connection cannot reach `:11434`,
   `:2375`, `:43120`, or another slot's sidecar port.
4. **Wizard**: full linked_device journey — review (with ToS disclosure copy) → loopback
   collect/confirm → approve/freeze → pair (QR rendered from sidecar, poll to linked, token
   → `snug_secrets`) → verify-before-claim (ADR-0025 pattern: `GET /session/status` with the
   just-minted token before any connected claim) → done; web shows the desktop-only
   disclosure wall; pairing-abandon and sidecar-unreachable paths surface named errors.
5. **Sidecar**: pairing mints the access token exactly once (≥256-bit CSPRNG) and completes
   only when the spawn-time nonce matches, so a bind-race squatter cannot pair; **EVERY**
   route requires the token — `/pair/*` included, reachable from the wizard only, never
   from an app (this replaces the original "every non-pair route 401s", which made the
   pairing routes an unauthenticated token-disclosure surface — see B5); server binds
   127.0.0.1 only (never 0.0.0.0); chats/history/messages/send endpoints are thread-scoped;
   responses ≤ net-frame size class; **no route ever serializes WhatsApp session key
   material** (negative test over every route against a populated real-shaped auth store).
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
   outgoing drafts are composed in the thread's observed user-response language; **every
   unattended send is written to an app-visible activity journal** (ADR-0033 §4, A8).
   Load-bearing negatives: an armed grant does NOT satisfy a confirm for a different
   thread; does NOT satisfy the wizard probe path (the confirm gate is a module-level
   singleton shared with it, `net.ts:100-118`); approve/re-approve/revoke clears standing
   grants; and rate-cap / quiet-hours refusals are distinguishable from a user denial.
9. **Translate**: received messages in a non-default language render the translate control
   (default-language messages must NOT — negative); tap yields an LLM translation into the
   default language, cached in the app DB; default language changeable in app settings.
10. **Desktop spawn**: shell command starts/supervises the sidecar; the new IPC command
    joins the C2 gate scope (IPC-unreachability-from-iframe check added); macOS gate green,
    Windows leg stays deliberately red (ADR-0021 D8 unchanged).
11. **Disclosures & data dignity**: ToS/ban-risk copy pinned in wizard + README; per-thread
    persona data has a visible "forget this thread" deletion affordance that cascades.
12. **New-reader scrub (B4)**: every LLM-bound payload derived from thread content passes a
    scrub at the turn's altitude — participant phone numbers and JIDs replaced with stable
    per-thread pseudonyms — with a negative test driving a real-shaped export containing a
    phone number and asserting it never appears in the LLM request body. Wizard consent
    copy (not only the README) states that under BYOK, other people's messages are sent to
    the configured model provider under the user's own key.
13. **Export parser (fixtures hostile to the mechanism)**: iOS bracketed, Android dashed,
    US 12-hour, dot-separated locale, and bidi-control-prefixed (U+200E / U+202F) line
    shapes all parse; multiline bodies attach to their parent message rather than splitting
    (the bug that would silently corrupt every per-person statistic); system lines,
    `<Media omitted>` and deletion tombstones never become messages; a message body
    CONTAINING a timestamp-shaped line stays one message. Export-derived (display-name)
    and live-derived (JID) identities are never silently merged — two participants sharing
    a display name must not be conflated.

**Out of scope**: media/voice messages (text-only v1); multiple simultaneously-armed threads
(one thread armed at a time); auto-reply while the hub app is closed (needs the ungoverned-
brain alternative — rejected); browser live path (disclosure wall); subscription mode
(byok/local only, ADR-0031 gap family); WhatsApp Business API; sidecar binary bundling
(v1 spawns system `node`, documented requirement); mDNS/auto-discovery (loopback is fixed).

## Plan

**Order** (tests FIRST within each phase; each phase is a reviewable commit chain):

- **Phase A — protocol** (tests first): add `linked_device` to **`AUTH_KINDS` in
  `packages/protocol/src/auth-schema.ts:35`** — NOT to `CONNECTION_KINDS`, which is derived
  from it (`connection-requirement.ts:66`); add a kind-coherence arm in the superRefine
  (`:550-571`, beside `'none'`'s) if the kind carries structural constraints. **No `lanHost`
  class is added** (B3/B5). Spec-changelog + SPEC_SYNC staged-draft note.
- **Phase B.0 — the shared contract (A5, lands FIRST)**: one constants module pinning every
  sidecar route, header name, and error code, imported by sidecar, wizard, and app alike.
  Per lessons.md:53, two surfaces inventing `x-snug-csrf` vs `x-csrf-token` integrated
  dead-on-arrival; Phase D's tests cannot be authored before these shapes exist.
- **Phase B — auth** (`well-known-providers.ts`, `requirement-admission.ts` + suites):
  the `whatsapp-personal` entry, kind `linked_device`, pinning a real host and NO `lanHost`
  seat. `WellKnownPairingExchange` gains a discriminated `device-link` variant (A3) —
  start → QR → poll → token — since the existing shape is a one-shot POST with a single
  `secretPath` and cannot express a poll. Gate 8's per-kind injection dispatch
  (`connected-fetch.ts:1029`) gains the `linked_device` arm; the hardcoded scopes
  disjunction (`well-known-providers.ts:1234`) is extended only if the kind consumes scopes.
  **`net-guards.ts`, `transportPolicy`, and the executor's host gates are NOT touched.**
  Brand-adjacency/alias coverage per A10. Phases A+B land together (A4: the exhaustive
  `Record`s and kind switches will not compile until both are in).
- **Phase C — sidecar** (NEW `apps/whatsapp-sidecar/`: `src/{server,routes,session,store}.ts`,
  Baileys behind a `WaSocket` seam so tests run against a scripted fake): pair/QR/status,
  token mint + auth middleware, chats list, history pages, since-cursor message poll, send
  with human-like pacing, loopback bind guard. Own vitest suite, tsc-gated like every
  package (AC5). Workspace + turbo wiring; add to root graph.
- **Phase D — wizard** (`state/connectionWizard.ts`, `ConnectionWizardSheet.tsx` + tests):
  a `linked_device` flow built as its OWN derived-boolean family beside the LAN one — NOT
  by extending `isLanRequirement` (B3: it is `lanHost !== undefined` with 13 call sites and
  a mandatory 64-hex TLS pin a loopback sidecar can never satisfy), and NOT by adding a step
  to the enum (`:79`), which the sheet documents at `:1570-1601` as a deliberate refusal.
  QR screen + linked-poll + ToS/BYOK consent copy + verify-before-claim (the ADR-0025
  `lanVerifiedAt` pattern, its own marker) + web disclosure wall. Negative: a
  `linked_device` row never enters `runLanPairingAttempt`, and `isLanRequirement` is false
  for it (AC4).
- **Phase E — starter** (`examples/whatsapp/` app.html single-file + embedded hooks,
  `connection.json`, `runtime-contract.json`, `authoring/` bundle; `starterApps.ts` shelf
  row; validate suites): thread picker → Persona Lab (user voice card, member profiles,
  dynamics map) → Insights (fun/emotional/active + response heatmap) → Reply Desk (Reply /
  Auto-reply arm switch) → per-message translate control + language setting → forget-thread
  affordance. Export-.txt parser lives in the app; analysis prompts ride the runtime
  contract (read `docs/.../prompt-engineering-reference` memory before authoring). Real
  sql.js DDL run once per the 2026-08-15 lesson (AC6/AC7/AC9/AC11).
- **Phase F — armed auto-reply**: a NEW `StandingApprovalGate` consulted BEFORE the session
  gate (B2/ADR-0033 §3) — keyed (appId, slot, threadJid, trigger scope), persisted with the
  connection, enforcing cap + quiet hours + kill switch, returning "no opinion" outside its
  frozen scope. `session-confirm.ts` keeps its memory-only property untouched. Thread
  identity is derived from the request and disagreeing path/body JIDs REFUSE. Plus the
  activity journal (A8). AC8's four negatives are the load-bearing tests.
- **Phase G — desktop spawn** (`apps/desktop/src-tauri`, moved EARLIER — after C, per S5,
  since C/D cannot be exercised without it): `sidecar_ctl` (spawn/supervise/stop, sole
  writer of the port and the spawn nonce) and **`sidecar_fetch`** (host+port+path admission
  in Rust, `/pair/*` off the app path) on the `lanfetch.rs` template, with cargo tests per
  refusal class; both commands join the C2 IPC gate scope (AC10).
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

## BLOCKER B3 (fresh-context review, verified independently) — `lanHost` is the WRONG seat: it would drag the row into hue's pinned-TLS pairing path

`isLanRequirement` is `requirement?.lanHost !== undefined` and NOTHING else
(`connectionWizard.ts:731-733`), and it has **13 call sites** across
`connectionWizard.ts` (`:345, :400, :428, :575, :657, :737, :842, :1203`) and
`ConnectionWizardSheet.tsx` (`:1175, :1197, :1519, :1581`). So any WhatsApp requirement
carrying a `lanHost` seat — of ANY class — fires every one of them and is routed into
hue-shaped host collection and hue-shaped pairing, whose `runLanPairingAttempt`
**hard-requires a 64-hex TLS certificate pin** (`:1031-1036`, refusing outright when
absent) over `https://${host}` (`:993`). A loopback sidecar serves plain http and has no
certificate, so it can NEVER satisfy that check. The withdrawn design was a dead end that
would only have surfaced mid-Phase-D.

Also confirmed: **there is no `pairing` step to reuse.** The wizard step enum is
`'review' | 'register' | 'credentials' | 'connect' | 'done'` (`connectionWizard.ts:79`);
the LAN screens are derived booleans, and the sheet documents (`:1570-1601`) why new steps
were deliberately NOT added. The plan's claim that ADR-0023 "built a provider-agnostic
pairing step machine" was **read from ADR-0023's prose (L116), not from code** — exactly
the failure lessons.md:69 (2026-08-15) warns about: *"A comment's claim about ANOTHER
surface is a pointer to verify, never evidence."* I repeated the very mistake the lessons
file exists to prevent, and the plan is corrected rather than the claim defended.

**Resolution: the sidecar connection does NOT use the `lanHost` seat.** It is a
`linked_device` requirement whose `declaredApiHosts` pins ONE symbolic host, with
reachability enforced by `sidecar_fetch` in Rust (B1). `isLanRequirement` therefore stays
false for it, all 13 sites keep their current behavior byte-for-byte, and the `linked_device`
wizard flow gets its own derived-boolean family beside the LAN one rather than colonizing it.
AC4 gains a negative: **a `linked_device` row never enters the LAN pairing path** —
`runLanPairingAttempt` refuses it by name, and `isLanRequirement` returns false for it.

## Further amendments from the fresh-context review (all verified before acceptance)

- **A1 (was B2 in the review) — `transportPolicy` has no class dimension.** It is a single
  boolean consulted via a hard-coded call: `lanPrivateHost = deps.transportPolicy?.allowHttpForPrivateHosts === true && isPrivateRfc1918Ipv4Literal(host)`
  (`connected-fetch.ts:977-978`), standing down the SSRF guard at `:1003` and forking
  transport at `:1122`. Under B1's redesign the executor is NOT modified at all for
  loopback — no class dispatch, no new policy seat, RFC-1918 behavior byte-identical. This
  is now a *reason to prefer* the `sidecar_fetch` design, not extra work.
- **A2 — the Tauri capability file states the position explicitly.** `apps/desktop/src-tauri/capabilities/main.json`
  records that blanket `http://127.0.0.1:*` is *deliberately absent* because "connected-fetch
  refuses loopback outright", with only two single-purpose port-scoped entries (Ollama 11434,
  debug gate 43120). The sidecar gets exactly ONE port-scoped entry in that same style — an AC.
- **A3 — the registry `pairing` seat cannot express QR+poll.** `WellKnownPairingExchange`
  (`well-known-providers.ts:59-94`) is a one-shot `POST` with a single `secretPath`; WhatsApp
  needs start → QR → poll → token. Phase B must add a discriminated variant
  (`kind: 'exchange' | 'device-link'`) rather than overloading the exchange shape.
- **A4 — Phase A will not compile green alone.** `LAN_HOST_CLASS_VALIDATORS` is an exhaustive
  `Record<ConnectionLanHostClass, …>` (`requirement-admission.ts:200-202`) and the protocol
  superRefine has a twin map (`connection-requirement.ts:537-539`). Adding the `linked_device`
  KIND has the same exhaustiveness effect wherever kind is switched on. Phases A+B land
  together, or the task file states the expected red. (Fail-loud is the intended design.)
- **A5 — pin the sidecar HTTP contract FIRST.** Promote the shared constants module to a
  **Phase B.0** deliverable, before both the sidecar (C) and the wizard (D), per lessons.md:53
  (2026-08-03: two agents invented `x-snug-csrf` vs `x-csrf-token` and integrated
  dead-on-arrival). Phase D's tests cannot be written before these shapes exist.
- **A6 — Gate 9a's condition must be class-explicit.** Today `lanPrivateHost && url.protocol === 'https:'`
  (`:1122`); make any future class fork explicit so an https loopback URL can never be routed
  at `lanFetch` and refused for a missing pin. Latent under B1, pinned by a negative test.
- **A7 — `isCollectableLanHost` is a THIRD copy of the class rule** (`connectionWizard.ts:757-770`,
  deliberately duplicated and cross-check-tested) and is used as a pairing guard at `:985`.
  Untouched under B1's redesign; listed so the next class change does not miss it.
- **A8 — journal the sends.** ADR-0033 §4 requires an app-visible activity feed for every
  unattended send; AC8 did not mention it. Added.
- **A9 — three list edits for the starter**, not one: `APPS`, `CONNECTED_APPS`, and
  `LLM_FREE_APPS` in `examples/validate.test.mjs` (parity enforced at `:496-512`, README at
  `:522`, authoring bundle at `:381`).
- **A10 — brand-impersonation coverage.** `registryHostIndex` skips `lanHost` entries, so the
  borrow ban reaches them by NAME only; "WhatsApp" is a high-value brand to impersonate.
  Under B3 the entry pins a real host, so it rejoins the host index — but alias /
  brand-adjacency coverage still gets an explicit test, as the hue entry has.

## BLOCKER B4 (fresh-context review) — third-party message content reaching a third-party LLM is a NEW READER with no scrub derived

`scrubAuthValues` (`packages/auth/src/scrub.ts:21-36`) scrubs **injected credential values
only**, by exact substring, for delivery **into the iframe**
(`connected-fetch.ts:1159,1162`). This app sends *other people's private messages* — people
who never consented and are not Snug users — to a third-party LLM API, and builds
psychological profiles of them. lessons.md:40 is exactly on point: when the consumer class
changes (app→LLM), re-derive what the scrub protects **per reader, at the new reader's
altitude**. AC11 covered deletion and ToS copy, not disclosure-at-send.

**New AC12 (added):** every LLM-bound payload derived from thread content passes a
**new-reader scrub at the turn's altitude**: participant phone numbers and JIDs are replaced
with stable per-thread pseudonyms before the turn, with a negative test driving a
real-shaped export containing a phone number and asserting it never appears in the LLM
request body. The wizard consent copy (not only the README) must state that with BYOK, other
people's messages are sent to the configured model provider under the user's own key. The
threat delta gains a **third-party-consent residual** distinct from the impersonation
residual — different people, different harm.

## BLOCKER B5 (adversarial review) — cross-app sidecar token capture, and the final reachability design

The adversarial review returned **UNSAFE — REDESIGN** on the original loopback proposal and
found an attack B1 alone does not close. Because the ceiling is host-granular, and because
AC5 as originally written said *"every non-pair route 401s without it"* — making `/pair/*`
**unauthenticated by design** — a SECOND app approved for `127.0.0.1` (its own unrelated
sidecar, or a hostile one) could poll the WhatsApp sidecar's `GET /pair/status` and
**capture its access token**. That is a C1 token-boundary break reached entirely through
approved surfaces: the per-slot credential isolation is not broken, it is bypassed by
fetching the credential over the network.

The reachable population also matters and is qualitatively worse than RFC-1918. Loopback is
where software binds *because* it treats "local = authenticated": Docker's TCP socket
(`POST /containers/create` with a host bind mount is root-equivalent), Ollama on 11434,
Postgres/Redis/Elasticsearch, Jupyter kernels (arbitrary code execution), and the
playground's own Vite dev server (`/@fs/` traversal). RFC-1918 reaches *appliances that
have their own auth*. Confirmed independently: `capabilities/main.json:4` records that
blanket `http://127.0.0.1:*` was **deliberately removed** because "connected-fetch refuses
loopback outright", and `netTransportCapability.test.ts:77-79` pins that exactly two
single-purpose loopback ports (11434 Ollama, 43120 debug gate) may exist. ADR-0021:38 states
"any further widening needs its own ADR."

Also confirmed: the original design was **unrepresentable**, not merely unwise.
`CONNECTION_HOST_RULE` (`connection-requirement.ts:211`) is LDH-only so a colon cannot pass,
and `normalizeAuthHost` (`auth-schema.ts:345-357`) requires `url.port === ''` — so
`"127.0.0.1:8787"` can never equal a URL-derived hostname and fails closed. ADR-0032 §4 as
drafted described an artifact the schema cannot store.

**FINAL DESIGN (supersedes B1's sketch; ADR-0032 §4 to be rewritten before Phase A):**
The sidecar is **not a host — it is a capability.** Modeling it as a ceiling entry is a
category error: the Hue bridge's address is genuinely user-chosen and unknowable, whereas
Snug *spawns the sidecar itself* and therefore already knows where it is.

1. **`sidecar_fetch`, a dedicated Rust command** on the `lanfetch.rs` template (whose header
   states the principle: *"every other guard is enforced HERE in Rust, before any socket is
   opened, because the TS caller is not the last word on what the shell will dial"*).
2. **The port is never webview-supplied.** `sidecar_ctl` binds the listener and is the only
   writer of the port into shell state; `admit()` refuses any host but `127.0.0.1` and any
   port but the one THIS shell spawned. Port granularity becomes structurally
   unrepresentable rather than schema-enforced.
3. **Path allowlist in Rust** — only the enumerated contract routes, so the command can
   never become a general loopback fetch primitive.
4. **`/pair/*` is main-window/wizard ONLY, never reachable on the app-facing path.** This
   closes the token-capture attack at its source rather than mitigating it.
5. **Spawn-time shared secret**: `sidecar_ctl` hands the sidecar an argv/env nonce, so a
   process that wins the bind race cannot complete pairing. (Loopback cleartext is NOT an
   eavesdropping risk — packets never leave the kernel — but port squatting is real, and
   unlike the RFC-1918 rung there is no TLS pin to defeat it.) The access token is ≥256 bits
   of CSPRNG entropy and required on every route including `/session/status`.
6. **`isForbiddenNetHost` and `isPrivateRfc1918Ipv4Literal` are NOT touched**, and
   `transportPolicy` gains no field. AC3's "browser profile byte-identical" then holds *by
   construction* rather than by test, and `netTransportCapability.test.ts`'s two-port
   assertion stays green **unmodified** — which is the signal the design is right.
7. **A2 is therefore WITHDRAWN**: a dedicated Rust command needs no `http:default` scope, so
   the capability file gains NO new entry at all. AC3 is amended accordingly.
8. **Addressing** rides ADR-0026 `snug-connection://whatsapp/...`, the slot resolving to the
   sidecar transport, which also buys host-cleanliness for free.

Considered and rejected: widening `CONNECTION_HOST_RULE`/`normalizeAuthHost` to carry
`host:port`. That changes the host-identity primitive shared by EVERY connection, forces a
migration story for existing frozen ceilings, and re-opens `canonicalRequirementHash`
(`:694`) — a stored-ceiling byte change mass-demotes live approvals (`:605-611`). Its own
ADR at minimum, and not justified by one provider.

Open for owner ratification (does not block Phase A): a **unix-domain socket** (0600) or
Windows named pipe instead of TCP would eliminate port squatting entirely. The task already
accepts a desktop-only, spawn-supervised runtime, so nothing requires TCP. Deferred as a
Phase-C design choice, recorded so it is a decision rather than an omission.

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

### 2026-08-16 — claude — plan review (High-tier prerequisite; owner approved the v1 plan)
- Done: the mandatory fresh-context plan review plus a dedicated adversarial review of the
  loopback proposal, both against the REAL code; Baileys 7.0.0-rc14 API verified from the
  published tarball. Five blockers found and the plan amended **before any implementation
  code was written** — which is the entire point of this gate:
  - **B1** the frozen ceiling is port-blind (`app-host-freeze.ts:24-27`), so `127.0.0.1`
    would have granted every loopback port; **B5** confirmed `127.0.0.1:8787` is
    *unstorable* (LDH host rule + `normalizeAuthHost` requires an empty port), and that
    unauthenticated `/pair/*` routes let a second approved app steal the sidecar token.
    Reachability redesigned onto a Rust `sidecar_fetch` command; no ceiling, no capability
    entry, no executor change.
  - **B3** a `lanHost` seat would have dragged the row into hue's pinned-TLS pairing path
    (13 `isLanRequirement` sites; mandatory 64-hex pin) — a dead end that would have
    surfaced mid-Phase-D. The plan's "provider-agnostic pairing step machine" claim was
    read from ADR-0023's PROSE and is false in code (there is no pairing step at all).
    That is exactly the failure lessons.md:69 warns about, committed by me; recorded rather
    than quietly fixed.
  - **B2** the session-confirm gate cannot carry a thread-scoped standing grant
    (`(appId, host, method)`, memory-only, no clock, shared with the wizard probe) —
    ADR-0033 §3 rewritten around a separate `StandingApprovalGate`.
  - **B4** LLM-bound message content is a NEW READER (lessons.md:40) with no scrub derived;
    added AC12 (pseudonymize JIDs/phone numbers) and a third-party-consent residual.
  - Plus A1-A10 and AC13 (export-parser fixtures hostile to the mechanism).
- **Correction to my earlier plan claim**: the `linked_device` kind is added to `AUTH_KINDS`
  (`auth-schema.ts:35`), not to `CONNECTION_KINDS`, which is derived from it. Phases A+B
  must land together — the exhaustive `Record`s will not compile otherwise (A4).
- State: **STOPPED again for owner re-approval.** The approved plan changed materially
  (reachability mechanism, wizard flow strategy, standing-grant design, two new ACs), and
  the owner approved v1, not this. Still no implementation code.
- Next step: owner ratifies the amended plan → Phase A+B failing tests together.
- Open questions for the owner: (1) unix-domain socket vs TCP for the sidecar (UDS removes
  port squatting entirely; desktop-only + spawn-supervised means nothing requires TCP);
  (2) the port default and starter name from the previous entry still stand.

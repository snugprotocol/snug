# TASK-20260816-whatsapp-twin: WhatsApp thread companion — persona analysis + mimic replies

- **Status**: in-progress (plan approved + amended; Phase A landed green)
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

**OWNER DECISION (2026-08-16): unix-domain socket, not TCP.** The sidecar listens on a UDS
at `~/Snug/whatsapp-sidecar.sock` with `0600` permissions, created by `sidecar_ctl`. This
is strictly stronger than the TCP design and simplifies it:
- **Port squatting is unrepresentable** — there is no port to race for, and filesystem
  permissions (not a bind order) decide who may connect. The spawn-nonce mitigation stays
  as defense in depth but is no longer the only thing standing between a squatter and the
  pairing flow.
- **`sidecar_fetch`'s admission simplifies**: no host check and no port check, because
  there is no TCP endpoint at all. What it admits is the METHOD + PATH against the
  enumerated contract, over a socket path the Rust side owns. Nothing on the machine's
  network stack can reach the sidecar — not another app, not another user's process, not a
  browser page.
- **`isForbiddenNetHost` is untouched and now trivially so**: no loopback URL ever exists.
- Windows: a named pipe with an equivalent DACL is the twin. Since the desktop Windows leg
  is deliberately red (ADR-0021 D8), v1 ships the UDS path and the named-pipe twin is
  authored behind the same seam, gated red with the rest of the Windows story rather than
  faked green.
AC3 is re-pointed at socket-path + method + path admission; the "every port but the pinned
one" clause is retired as unrepresentable-by-construction, which is the better outcome.

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

## HANDOFF — 2026-08-16, for a fresh session

**Branch** `feat/TASK-20260816-whatsapp-twin` @ `c96e3e1`, 15 commits ahead of `main`
(`5825fb7`), working tree clean. Nothing exists only in a chat.

**Verified green at handoff**: root `turbo run test --force` → **23/23 tasks, 0 cached**
(protocol 329 · knowledge 184 · runner 110 · server 126 · adapters 124 · db 306 · sdk 41 ·
auth 787 · desktop 124 · playground 1121 · whatsapp-sidecar 18) plus **cargo 64**.
Re-run this FIRST in the new session before trusting anything below.
**(2026-08-16 pickup: doing so found the desktop crate did not COMPILE — `tokio` was a
dev-dependency used by production code. Repaired; see the last journal entry. Re-run
`cargo check --lib` too, not only `cargo test`: the test profile hid this.)**

**Done (A, B.0, B, C, G, D)** — the whole connection path, end to end:
| Phase | What shipped |
|---|---|
| A | `linked_device` kind in `AUTH_KINDS` + schema coherence arm |
| B.0 | `packages/protocol/src/sidecar-contract.ts` — the shared route contract |
| B | `whatsapp` registry entry + the `device-link` pairing variant |
| C | `apps/whatsapp-sidecar` — Baileys behind a `WaSocket` seam |
| G | `sidecar.rs` (`sidecar_ctl`, `sidecar_fetch`) + `ipc-sidecar-fetch-refused` |
| D | `isLinkedDeviceRequirement`, `beginDeviceLink`/`completeDeviceLink`, 2 screens |

**Next: Phase E — the starter app** (`examples/whatsapp/`), the largest remaining piece and
the visible half of the owner's original ask. Then F (armed auto-reply via a NEW
`StandingApprovalGate` — see B2, do NOT widen the session gate) and H (docs close).

**Read before writing Phase E code** (in this order):
1. This file's **BLOCKER B1/B3/B4/B5** sections — they record designs already withdrawn.
   Do not re-propose a loopback host class or a `lanHost` seat for the sidecar.
2. `docs/decisions/0032` and `0033` (both still **proposed**; H moves them to accepted).
3. `examples/hue/` and `examples/trade-copilot/` as the shape to match: `app.html`,
   `connection.json`, `runtime-contract.json`, `authoring/` bundle.
4. The prompt-engineering reference memory before authoring any analysis prompt.
5. `/private/tmp/.../scratchpad/export-formats.md` is GONE with the session — its content is
   folded into **AC13**, which is the spec for the export parser.

**Phase E gotchas already known:**
- `examples/validate.test.mjs` enforces THREE list edits (`APPS`, `CONNECTED_APPS`,
  `LLM_FREE_APPS`) plus a README per folder and an `authoring/` bundle (A9).
- The app's DDL must execute against **real sql.js once** before it ships — a mocked bridge
  accepts identifiers the real engine refuses (lessons.md 2026-08-15, the `DEFERRABLE` case).
- **AC12 is not optional**: pseudonymize phone numbers/JIDs before any LLM turn, with a
  negative test driving a real-shaped export. Third parties never consented.
- No `<form onSubmit>` — the sandbox blocks submission before the event fires.

**Owner decisions still open (both cheap, both block nothing until E starts):**
- ~~**Starter display name**~~ — **SETTLED 2026-08-16: "WhatsApp Twin"** (see last journal entry).
- Whether Phase G may split into its own PR if the chain grows. *(Still open; blocks nothing.)*

**Owner verification owed (no test can cover these):** the macOS shell gate has not been
re-run on hardware since `sidecar_ctl`/`sidecar_fetch` landed (needs a real shell build; the
Windows leg stays deliberately red per ADR-0021 D8), and the sidecar is spawned via system
`node` against `~/Snug/helpers/` — packaging is deliberately out of scope.

**Standing constraint to re-state to any new session:** auto-reply runs only while the
desktop app is open, because the sidecar is deliberately LLM-free (ADR-0032 §1). That is a
C1 consequence, not an oversight — do not "fix" it by giving the helper a model key.

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

### 2026-08-16 — claude — Phase A (owner ratified the amended plan; UDS chosen)
- Owner decision: **unix-domain socket**, not TCP. Folded into the plan and ADR-0032 §4:
  port squatting becomes unrepresentable (no port to race for; 0600 filesystem permissions
  decide who connects), `sidecar_fetch`'s admission simplifies to method+path, and the
  "every port but the pinned one" AC3 clause retires as unnecessary. Windows named-pipe
  twin is authored behind the same seam but gated red with the rest of the D8 story.
- Done, Phase A (tests FIRST, then implementation):
  - `connection-linked-device.test.ts` (8 tests) written and confirmed RED for the right
    reason before any implementation — the two "the kind exists" assertions failed.
  - `linked_device` appended to `AUTH_KINDS` (`auth-schema.ts`); **appended, never
    inserted**, so no stored row's kind can be re-read as a different kind.
  - Schema coherence arm placed BEFORE the `none` arm (which ends in an early return):
    must declare its token field, no OAuth endpoints, **no `lanHost` seat**.
  - **Mutation-checked**: neutralizing the arm turns all three coherence tests red, each
    for its own reason. Before the arm existed they passed only because an unknown kind is
    rejected wholesale — i.e. they were measuring nothing, the exact trap lessons.md names.
- Three pinned-set tripwires fired and were updated DELIBERATELY, not regenerated blindly:
  `AUTH_KINDS` order+membership, `CONNECTION_KINDS` (`none` stays last), and the
  auth-schema snapshot (verified: exactly one line added, no other drift).
- **Consequence found by the gates, not by inspection** — the one worth remembering:
  `render.ts:59` injects `AUTH_KINDS.join(', ')` straight into the auth-spec-inferrer's
  system prompt, so adding a kind silently told the model it may PROPOSE `linked_device`.
  It must never: that kind needs a companion helper the user installed, so an inferred row
  is a connection that can never work. Added an explicit refusal rule to the prompt plus
  its own test (asserting the WHY, so a future edit cannot drop the carve-out while keeping
  the list injection) — and note the prompt is compiled: `.md` edits need `gen:content`.
  **Generalizable lesson (for Gate 6): a value injected into a prompt makes every future
  addition to that value a prompt change.**
- Two exhaustive kind switches in user-facing consent copy (`ConnectionWizardSheet.tsx`,
  `ConnectionSlotsCard.tsx`) failed the type gate and gained honest `linked_device` wording
  — "links as an extra device… can read and send as you… your sign-in details are never
  given to Snug". Consent copy states the consequence, never the enum.
- Verified: root `turbo run test --force` **21/21 tasks, 0 cached** (protocol 302→310,
  knowledge 183→184; every other count unchanged).
- Next step: Phase B.0 — the shared sidecar contract constants module (must precede C and D).

### 2026-08-16 — claude — Phase B.0 (the shared sidecar contract)
- Done: `packages/protocol/src/sidecar-contract.ts` + 19 tests. Routes are method-pinned;
  `APP_REACHABLE_SIDECAR_ROUTES` is DERIVED from the full table (two hand-written lists
  could drift invisibly until an app reached a route nobody intended). `/pair/*` and
  `/session/status` are wizard-only — that subset IS the refusal for the cross-app
  token-capture attack, and the Rust admission will be generated from it.
- **A surviving mutant found a real hole in my own guard — the session's best catch.**
  Deleting the traversal refusal left all 17 tests GREEN. Cause: every traversal fixture I
  wrote (`/chats/../pair/status`) was already refused by the anchored route matcher, so the
  fixtures tested the matcher twice and the traversal guard zero times. The dangerous shape
  is `/chats/../messages` — `..` is a LEGAL single path segment, so it matches
  `/chats/:jid/messages` exactly and ONLY the traversal guard stands between it and
  admission. Fixed both sides: fixtures that fail *only* the guard under test, and a guard
  that DECODES before checking and refuses on the segment primitive, because `%2e%2e`
  defeats a literal `..` scan (lessons.md 2026-08-11: neutralize the primitive, not one
  spelling — the attacker picks the spelling). Both mutants now die, each for its own
  reason; a third mutant pinning the literal-scan version dies on the encoded fixture alone.
  This is lessons.md 2026-08-04 + 2026-08-13 in one incident: *a refusal's test input must
  pass every SIBLING refusal and fail only the one under test*, and *when a mutation stays
  green, suspect the fixture before the mutation*.
- Verified: root `turbo run test --force` **21/21, 0 cached** (protocol 310 → 329).
- Next step: Phase B — the `whatsapp-personal` registry entry + the `device-link` pairing
  variant + gate 8's `linked_device` injection arm.
- **Gate 6 candidates (two new lessons):** (1) a value injected into a prompt makes every
  future addition to that value a prompt change — `AUTH_KINDS` reaches the inferrer's system
  prompt via `render.ts`, so adding a kind silently granted the model a new proposal; (2) an
  anchored route matcher does NOT imply traversal safety, because `..` is a legal segment —
  test the guard with a path the matcher admits.

### 2026-08-16 — claude — Phase B (registry entry + device-link pairing)
- Done: the `whatsapp` registry entry (the owner's ask — every future user-authored WhatsApp
  app now inherits one reviewed wizard) and a DISCRIMINATED pairing union. Hue's one-POST
  exchange cannot express start → QR → poll (the token arrives in a response `secretPath`
  cannot name), so `kind: 'exchange' | 'device-link'` — and the discriminant is REQUIRED, not
  defaulted, because a defaulted discriminant makes "nobody decided" and "this is an
  exchange" the same value. 16 new tests here, 787 total in auth (was 759).
- **Two real bugs, both caught by a red test rather than by reading:**
  1. **The brand was unprotected.** Keyed `whatsapp-personal`, the entry was reachable by
     NEITHER resolution rung — both key on the normalized registry key, and
     `normalizeProviderKey('WhatsApp')` is `whatsapp`. So the borrow ban never fired for the
     WhatsApp brand and a declaration wearing the name while aiming the credential at
     `evil.example` was **admitted**. Renamed to `whatsapp`; pinned by its own regression
     test asserting both rungs resolve, because the next author will pick a key by
     aesthetics unless something fails. **This is ADR-0023's P6 amendment repeating in a new
     entry** — the hue rows hit the identical trap (`'Philips Hue'` → `philipshue`, not the
     key `hue`). Twice is a pattern: Gate 6 candidate — *a registry key is a resolution
     input, not a label; pick it by what `normalizeProviderKey(displayName)` returns.*
  2. **The alias `'WhatsApp'` shadowed its own key** — refused by the self-containment
     suite, and rightly: an alias that shadows a key silently re-routes a resolution that
     already worked.
- Three structural suites fired and were each acknowledged deliberately, never loosened:
  the kind table (12th entry), `browserCallable` (a unix socket is unreachable from a
  browser — the most documented `false` in that table), and — the ADR-0032 §4 seam proving
  itself — `lanPairingExchangeFor` in the wizard, which now NARROWS on the discriminant so a
  device-link seat can never reach the pinned-TLS path that demands a 64-hex certificate pin.
  `isLanRequirement` already excluded the row; the narrowing is the belt the compiler checks.
- Verified: root `turbo run test --force` **21/21, 0 cached**.
- Next step: Phase C — the sidecar package (`apps/whatsapp-sidecar`), Baileys behind a
  `WaSocket` seam so the suite runs against a scripted fake; then Phase G's `sidecar_ctl` +
  `sidecar_fetch` Rust commands, which C/D cannot be exercised without.

### 2026-08-16 — claude — Phase C (the sidecar package + router)
- Done: `apps/whatsapp-sidecar` (package, tsconfig pair, tsc-gated `test` script like every
  other package) with Baileys behind a narrow `WaSocket` seam. 18 tests, all against a
  scripted fake — no network, no phone, no real account. The seam is not speculative: the
  7.x line reshapes payloads between release candidates, so an upgrade is one adapter file.
- The process is **LLM-free by construction** — analysis, persona work, translation and
  reply composition all stay in the governed host. A sidecar that composed its own replies
  would be a second brain outside every reviewed surface.
- Refusals implemented and **each mutation-checked (M1–M4 all die)**: every route needs a
  credential with `/pair/*` INCLUDED (the original "every non-pair route 401s" would have
  left the token-releasing route open); no route serializes WhatsApp key material, asserted
  against a POPULATED real-shaped auth store because an empty one passes for the wrong
  reason; thread scoping with an honest 404; and the history sync state — including
  `explicit:false` — rides with every page so an app cannot render an INFERRED completion
  as the whole record.
- **A surviving mutant earned a test, for the second time this task.** Removing the store's
  re-mint guard left all 17 green: the router only calls `setToken` when it already believes
  no token exists, so the router's check MASKED the store's and that guard was decoration.
  Driving the store directly separates them. Two guards for one property is fine; a guard no
  test can distinguish from its absence is a comment. **Gate 6 candidate (generalizes the
  Phase B.0 catch): when two layers guard one property, at least one test must drive the
  inner layer directly, or the outer guard makes the inner one untestable.**
- Verified: root `turbo run test --force` **23/23 tasks, 0 cached** (was 21 — the sidecar's
  build and test joined the graph; confirmed the package is really in it, since a package
  turbo does not know about is a package CI never runs).
- Next step: **Phase G** (taken early, per the plan review's S5) — `sidecar_ctl` (spawn,
  supervise, own the socket path and nonce) and `sidecar_fetch` (method+path admission in
  Rust, `/pair/*` off the app path) on the `lanfetch.rs` template, plus their cargo tests and
  the C2 IPC-unreachability gate entries. Phase D (wizard) follows, then E (starter app),
  then F (armed auto-reply).

### 2026-08-16 — claude — Phase G (the Rust commands + the C2 gate row)
- Done, in two commits. **Part 1 — admission**: `sidecar.rs` enforces method + path against
  the enumerated contract, traversal on the DECODED form, and the 1 MiB cap, all before a
  socket opens (the `lan_fetch` precedent: the TS caller is not the last word on what the
  shell will dial). `/pair/*` and `/session/*` are refused outright on the app path.
  **Part 2 — the commands**: `sidecar_ctl` (spawn/supervise; SOLE writer of the socket path
  and the 256-bit CSPRNG spawn nonce; `start` idempotent so a second call cannot spawn a
  rival racing for the socket) and `sidecar_fetch` (dials the unix socket; the HTTP exchange
  is hand-rolled because the cap must be enforced WHILE READING — a client that buffered
  first would defeat the bound before this code saw a byte).
- **The Rust route table is a deliberate restatement** of the TS contract (this crate is
  across an IPC boundary), so per the codebase's own rule it earned an equivalence test that
  PARSES the Rust source rather than retyping it — and I verified it catches drift in BOTH
  directions (Rust admitting a pairing route trips two tests; Rust dropping a route trips
  one), plus a non-vacuity assertion so a regex matching nothing cannot pass silently.
- **C2**: `ipc-sidecar-fetch-refused` joins `IPC_CHECK_IDS` with its own callback slot,
  per the amendment-16 per-command discipline — registration is per-command, so a
  family-level check cannot see a command added to the wrong handler list, and reaching THIS
  command from app code means reaching the process holding the user's linked-device session.
  The gate driver derives expectations from source, so the new check is required on every
  run automatically (verified by running the driver's own parse). Two isolation tests pin
  that neither command's refusal can grant the other's verdict.
- **Two things caught mid-phase, both the kind this task keeps surfacing:**
  1. `decideSidecarFetchRefused` shipped with **zero coverage** — the suite passed only
     because the type gate was satisfied. Untested code guarding a credential boundary; now
     8 tests. *A green suite says nothing about code no test calls.*
  2. The type gate then caught the untrusted-subframe report normalizer missing the new
     field, which would have silently defaulted rather than failed.
  3. A suite reported **"no tests"** rather than failing — jsdom rewrites `import.meta.url`
     so `fileURLToPath` refused. Fixed with the `@vitest-environment node` pragma the
     sibling capability suite already documents. *A suite that does not run is not a suite
     that passes* (lessons.md 2026-08-06, earned again).
- Reused `userfile::snug_dir` (now `pub(crate)`) rather than re-deriving `~/Snug`: that rule
  already shipped a Windows-ordering bug once, and a second spelling is how it ships again.
- Verified: cargo **64 tests** (48 at phase start); root `turbo run test --force` **23/23,
  0 cached**; desktop 105 → 120.
- **Not yet done in G, deliberately**: the helper is spawned via system `node` against
  `~/Snug/helpers/` — packaging/bundling the sidecar is out of scope per the task's own
  out-of-scope list, and the macOS shell gate has NOT been re-run on hardware (it needs a
  real shell build; the Windows leg stays deliberately red per ADR-0021 D8). Both are owner
  verification items, not silent gaps.
- Next step: **Phase D** — the `linked_device` wizard flow (QR + poll + verify-before-claim,
  its own derived-boolean family beside the LAN one, never extending `isLanRequirement`).

### 2026-08-16 — claude — Phase D (the linked-device wizard flow)
- Done in two commits (state layer, then sheet). `isLinkedDeviceRequirement` is its OWN
  predicate keyed on KIND; `canLinkDevice` requires BOTH platform seats; `beginDeviceLink`
  starts the helper and returns a QR; `completeDeviceLink` polls and then runs the ADR-0025
  verify read **before** handing back anything to store. Two derived booleans in the sheet
  (`linkWall`, `linkNeedsPairing`) beside the LAN family's three, plus two screens.
- **The ordering is the property**: a mint returning is not evidence the credential works,
  so a wizard can never claim connected on the strength of a mint alone. And an unreachable
  helper is a NAMED failure rather than "still waiting" — waiting on something that will
  never answer is the wizard hanging on a case the user could fix in seconds.
- Consent copy sits on the screen where the user ACTS, not upstream where it gets clicked
  past: what the link can do (read and send), what Snug never gets (sign-in details), how to
  undo it (unlink from the phone). Each clause is asserted separately so a copy edit dropping
  one cannot pass on the strength of the others.
- **A mutant survived again and taught the same lesson in a new place.** Deleting the
  empty-token guard left everything green because the fixture had no scripted verify call, so
  execution fell through to an unscripted call that threw — the test asserted `ok:false` for
  a reason unrelated to the guard it named. Fixed the FIXTURE (it now passes every sibling
  refusal and fails only on the guard under test) and added an empty-string sibling case.
- **Cross-package seam identity test** added from the integrating side, because this is
  exactly the shape lessons.md 2026-08-13 says ships green twice: desktop owns the
  implementation, the playground injects fakes, nothing owns the wire. Verified it catches
  both a cut wire AND a lambda substitution that a structural "is a function" check waves
  through.
- **Recorded honestly in the test file**: the "never LAN" sheet test still passes with the
  linked-device family disabled, because a `linked_device` row has no `lanHost` so the LAN
  screens are absent either way. It proves what it is named for and no more; the three
  sibling tests prove the screens are actually reached. Stated so no reader credits it with
  a guarantee it cannot give.
- Corrected mid-phase: my first sheet test invented a `__testExports` hatch into production
  code to reach the private screens. Replaced after reading how the LAN screens are actually
  tested — render the real sheet, assert by `data-testid`, never reach into module internals.
- Verified: root `turbo run test --force` **23/23, 0 cached**; playground 1102 → 1121,
  desktop 120 → 124.
- Next step: **Phase E** — the starter app (`examples/whatsapp/`): thread picker, Persona Lab,
  Insights, Reply Desk, inline translate, forget-thread. Then **Phase F** (armed auto-reply
  via the new `StandingApprovalGate`) and **Phase H** (docs close: ADRs to accepted, threat
  delta, code-map rows, spec-changelog).

### 2026-08-16 — claude — pickup: the desktop crate did not build (Phase G repair)

- **The handoff's "re-run this FIRST" instruction earned itself.** Root
  `turbo run test --force` reproduced exactly (**23/23, 0 cached**, every per-package count
  matching), but `cargo test` **did not compile**, and neither did `cargo check --lib`:
  the desktop shell could not be built at all.
- **Cause**: `send_over_unix_socket` (`sidecar.rs:362-363`) — production library code, well
  above the `#[cfg(test)]` boundary at `:425` — uses `tokio::io` and `tokio::net::UnixStream`,
  but Phase G part 2 (`8db0ced`) added `net` + `io-util` to the **`[dev-dependencies]`** tokio
  line. Right features, wrong section. Under `cargo test` the dev-deps are linked, so the
  crate compiles; nothing in the repo ever built the lib WITHOUT them, so the gap was
  invisible from the test leg alone.
- **Correction to the Phase G journal entry**: it recorded "Verified: cargo **64 tests**".
  The count is real — after the fix the suite reports exactly 64 — so the tests were genuinely
  written and genuinely run. What the entry could not have covered is the *build*: a green
  `cargo test` is not evidence that the crate compiles, because the test profile links a
  strictly larger dependency set than the release profile. Recorded rather than quietly
  fixed, per this task's own standing practice.
  **Gate 6 candidate (new, and a sibling of the ones already banked): `cargo test` passing
  does not mean the crate builds — dev-dependencies are linked for tests and absent from the
  release profile, so a production `use` of a dev-only crate is green in CI's test leg and
  broken in every real build. The check that catches it is `cargo check --lib`.**
- Fix: `tokio` declared in **`[dependencies]`** with `default-features = false` and only the
  two features the transport needs (`net`, `io-util`); the `[dev-dependencies]` line keeps
  `macros` + `rt-multi-thread` for `#[tokio::test]`. Cargo unions the sets, so each section
  now states only why IT needs tokio, and neither can be deleted without a named failure.
- **Second, smaller find in the same file — the pattern this task keeps surfacing.**
  `socket_path` (`:206`) documents itself as the owner of the socket-path rule ("Chosen HERE
  and never accepted from the webview") and had a test, but **no production caller**:
  `sidecar_ctl` inlined `dir.join(SOCKET_BASENAME)` at `:282`. So the test proved a rule the
  shipping path did not execute, and the two agreed only by both happening to be a `join` —
  a guard indistinguishable from its absence, exactly the Phase B.0 / Phase C shape one layer
  down. Surfaced by the `dead_code` warning, not by inspection. `sidecar_ctl` now calls
  `socket_path`, so the existing test covers the real derivation.
- Verified after both changes: `cargo check --lib` clean (the `dead_code` warning is gone; the
  remaining snake-case warning is pre-existing in `lanfetch.rs`), `cargo test` **64 passed**,
  root `turbo run test --force` **23/23, 0 cached**.
- **Owner decision (2026-08-16): the starter display name is "WhatsApp Twin"** — ratified,
  replacing the unratified "Twin" proposal. It lands in the manifest, the shelf row and the
  README when Phase E starts. Rationale: explicit about the provider so the shelf row is
  unambiguous; the ToS/impersonation disclosure already sits in the wizard consent copy and
  the README, so brand-adjacency is disclosed rather than implied.
- State: **STOPPED at owner request** for a proper review of Phase G before Phase E begins.
  Working tree committed; nothing exists only in this chat.
- Next step: owner reviews Phase G (`aa26475`, `8db0ced`, plus this repair) → then **Phase E**,
  the starter app, whose two blocking inputs are now settled (name ratified above; the
  Phase-G-splits-into-its-own-PR question is still open but blocks nothing).
- **Still owed by the owner, unchanged**: the macOS shell gate has not been re-run on hardware
  since `sidecar_ctl`/`sidecar_fetch` landed — and note that until this repair it *could not*
  have been, since the shell did not build. The Windows leg stays deliberately red (ADR-0021 D8).

### 2026-08-16 — claude — Phase E (the starter app)

- Done: `examples/whatsapp/` — the 11th shelf app and the 6th connected one. `app.html`
  (single file, hooks block byte-identical by CONSTRUCTION — assembled by `cat`, never
  transcribed), `connection.json`, `runtime-contract.json`, README, and the `authoring/`
  bundle (vision / requirements / plan / lessons + the verbatim build prompt). Five surfaces:
  thread picker with honest sync state, export ingest, Persona Lab (+ forget-thread), Insights,
  Reply Desk (draft → confirm; arm switch; activity journal), per-message translate, settings.
- **Tests FIRST**: `examples/whatsapp-analysis.test.mjs` (19 tests) written and confirmed RED
  before the app existed. It EXTRACTS the two pure functions from the shipped `app.html`
  between explicit markers and evaluates them — a copy of the functions in the test file would
  pass forever after the app drifted, which is the failure the seam exists to prevent. The
  extraction asserts a non-empty slice, so a rename fails loudly instead of testing nothing.
- **All 19 passed on the first run, which is exactly when this task's own lesson applies.**
  Mutation-checking found **two tests measuring nothing**, both fixture faults, not code faults:
  1. The JID-scrub test used a JID as the AUTHOR, so the pseudonym map replaced it by exact
     name and `JID_PATTERN` was never reached — deleting the regex entirely left it green. The
     dangerous shape is a JID belonging to someone NOT in the thread, forwarded into a body:
     no map entry can match it, so the primitive is the only guard. Added that fixture.
  2. The "stable pseudonyms" test built the map twice from the SAME array, where insertion
     order is identical either way, so an unsorted map passed. Rewritten to vary arrival
     order — which is what `sort()` actually defends against (a later history page, a
     re-analysis) and precisely when a shuffled label would re-attribute one person's
     psychology to another.
  Seven mutations now checked; every one dies for its own reason. **This is the third time
  this task has hit "a fixture that passes for a reason unrelated to the guard it names"**
  (Phase B.0's traversal fixtures, Phase D's empty-token guard, now these two) — the pattern
  is stable enough to be worth a Gate 6 entry on its own.
- **A harness lesson worth keeping**: two "surviving" mutants in the first pass were perl
  shell-escaping failures — the file was never edited. A mutation harness MUST assert the
  mutation applied, or "no test failed" reads as "the guard is untested" when it means "the
  mutation never happened". Rebuilt the harness to fail loudly on a no-op replace.
- Verified beyond the suites, because a starter that only passes structural gates can still
  be dead on arrival: **JSX compiles** (esbuild over the extracted babel script) and the
  **DDL plus every runtime statement executes against real sql.js 1.14.1** — the 2026-08-15
  `DEFERRABLE` lesson, honoured rather than cited.
- Registrations, all four: `APPS` + `CONNECTED_APPS` (`validate.test.mjs`), `MANIFEST_APPS` +
  `P4_STARTER_FOLDERS` (`connection-manifests.test.mjs`), `CONNECTED_FOLDERS`
  (`starterShelf.test.tsx`), and the `STARTER_LOOKS` row (desktop-only, distinct emoji 🪞).
  `LLM_FREE_APPS` deliberately NOT touched — Twin is agent-driven.
- **Fixed a latent lie in a sibling gate**: `connection-manifests.test.mjs` hardcoded
  `assert.equal(declaring.length, 5)` under a test NAMED "exactly five". That file's own
  header records an earlier draft whose name promised six while the assertion pinned five;
  a literal count is how that recurs. Now derived from `MANIFEST_APPS.length`, with the name
  repointed at what it actually checks.
- `connection.json` and `runtime-contract.json` validated by PARSING them through the real
  `connectionRequirementSchema` / `runtimeContractSchema`, not by eye. The contract's
  `stateGuidance` was 527 bytes against a 500 cap on the first draft — the schema caught it.
- Verified: `pnpm --filter examples test` **188 passed**; root `turbo run test --force`
  **23/23, 0 cached**; cargo **64**. Confirmed `examples` really is in the turbo graph
  (24 dry-run entries) rather than assuming — a package turbo does not know about is a
  package CI never runs.
- **Not done in E, deliberately**: the arm switch currently holds armed state in component
  state only. The HOST-side enforcement — the `StandingApprovalGate` keyed on
  (appId, slot, threadJid, trigger scope), the rate cap, quiet hours, and thread derivation
  from the request — is **Phase F**, and ADR-0033 §3 is explicit that armed must be a
  recorded answer the host enforces, not an app-side boolean. The app surface is built so F
  wires into it; until F lands, arming is UI only and must not be described as enforced.
- Next step: **Phase F** (the `StandingApprovalGate` — do NOT widen the session gate, see B2;
  AC8's four negatives are the load-bearing tests), then **Phase H** (docs close: ADR-0032/0033
  to accepted, threat delta, code-map rows, spec-changelog, next-steps prune).

### 2026-08-17 — claude — Phase F, part 1 (the host-side standing gate)

- Done: `packages/auth/src/standing-approval.ts` + 22 tests. The gate **WRAPS** the session
  gate rather than widening it (B2/ADR-0033 §3) — and composition is the property, not a
  convenience: this gate is the ONLY caller of the session gate, so "consulted first, falls
  through outside its frozen scope" is structural rather than a convention a later edit could
  invert. `session-confirm.ts`'s key and its memory-only header are untouched.
- AC8's four load-bearing negatives all pass, each falling through to the ordinary confirm
  rather than refusing outright (the refusal to decide is never itself an approval): a
  different thread, a different app, the wizard probe path, and a non-send route on the armed
  thread. Plus the ADR-0033 §3 derivation seat: **disagreeing path/body JIDs REFUSE**, never
  pick one — "trust the path" and "trust the body" are the same vulnerability in two
  spellings. Rate-cap and quiet-hours refusals are returned as distinct `outcome`s via
  `decide()`, so an app can tell "you hit your cap" from "the user said no".
- **A fifth surviving mutant, and the same shape for the fourth time this task.** Deleting
  the wizard-probe exclusion left every test green: my fixture used the armed request with
  `slot: undefined`, but the NEXT guard (`grant.slot !== request.slot`) refuses
  `'whatsapp' !== undefined` anyway — so it tested the slot-match guard twice and the probe
  exclusion zero times. Fixed by arming a grant that ALSO has no slot, so every sibling guard
  would admit the request and the probe check is the only thing left standing. All five
  mutants now die for their own reasons. **This is now four separate instances in one task
  (B.0 traversal, D empty-token, E ×2, F) — Gate 6 should carry it as a named pattern: a
  refusal fixture must be constructed to pass every SIBLING refusal first.**
- **Executor change, minimal and additive**: `NetConfirmRequest` gains OPTIONAL `slot` and
  `body`. ADR-0033 needs a thread decision, and a thread is underivable from a URL alone.
  Optional is the design — every existing caller is byte-identical, and the ABSENCE of `slot`
  on the absolute-URL path is exactly what keeps a standing grant off the wizard's probe.
  - One existing test broke, correctly: `connected-fetch.test.ts` pinned the confirm request
    by EXACT equality. I kept it exact (adding `body`) rather than loosening to
    `objectContaining` — this is a C1-adjacent seat, and a future field arriving unnoticed is
    precisely what that assertion exists to catch.
  - Added the symbolic-path positive (`connection-url-resolution.test.ts`), because
    `confirm-seat-scope.test.ts` only pins the ABSENT case: without it, a cut `slot` wire
    would read as "the probe is correctly excluded" while arming silently never matched
    anything. Mutation-verified — cutting the wire kills exactly that test.
- Wired in the playground: `standingGate` wraps `confirmGate` and is what the executor
  receives. `invalidateNetGrants` now clears BOTH, so every existing approve/re-approve/revoke
  call site (10 of them, already in place) clears standing grants for free — a standing
  approval outliving a connection change would be worse than a session one doing so.
- **Stated rather than hidden**: the v1 grant store is IN-MEMORY, so an armed thread does not
  survive a page reload. ADR-0033 §2 wants it persisted with the connection. A reload is
  therefore a disarm, which is the safe direction to fail, but it is not what the ADR
  specifies and must not be described as done.
- Verified: auth 787 → **813**; playground 1121; root `turbo run test --force` **23/23,
  0 cached**; cargo **64**. Rebuilt auth before trusting the playground (the 2026-08-15
  dependent-build lesson — the first playground run failed on stale `dist` exactly as it warns).
- **BLOCKED, needs an owner decision — the app cannot reach the gate.** The arm switch lives
  inside the sandboxed iframe, and the frame vocabulary (`FRAME_TYPES`,
  `packages/protocol/src/constants.ts:15-24`) has no frame for arming: an app can send
  `snug:net-request`, `snug:db-request`, `snug:app-message` and nothing else. So Phase E's
  switch still holds component state only, and the host gate it should drive is currently
  reachable only from host code. Closing this needs one of:
  1. **A new protocol frame** (`snug:standing-request` or similar) — a C3 spec-sync change
     with its own schema, runner routing, size class and review surface. Most honest, biggest.
  2. **A host-rendered arm control** (the connections/settings card owns arming, the app only
     displays state) — no protocol change, and it puts a standing approval on a host surface
     the app cannot forge, which is arguably where ADR-0033 §2's "disclosed wherever the
     connection is disclosed" already points.
  3. **Defer arming to a follow-up task**, shipping Twin with manual Reply only.
  My recommendation is **(2)**: it needs no protocol change, and a standing write approval
  granted by a gesture the app itself renders is a weaker guarantee than one granted on a
  host surface — the app is the party that benefits from being armed.
- Next step: owner picks the arming surface, then Phase F part 2 (the chosen surface + the
  activity-journal read-back), then **Phase H**.

### 2026-08-17 — claude — owner decisions + Phase H (docs close)

- **Owner decisions (both recorded, both acted on):**
  1. **Arming surface DEFERRED to a follow-up.** Twin ships manual Reply only.
  2. **Standing grants stay IN-MEMORY for v1**, documented as a residual rather than
     presented as satisfying ADR-0033 §2.
- **Consequence handled rather than left dangling**: Phase E's arm switch was removed from
  `examples/whatsapp/app.html`, not merely disabled. A switch that sets a boolean and
  authorizes nothing is theatre; worse, a control that LOOKS like it granted a standing
  write approval while the host recorded none tells the user something untrue about what
  Snug may send in their name. The panel now states what is true — unattended replies are
  not enabled, here is what will govern them when they are, use `draft a reply` — and the
  dead `armed`/`setArmed`/`armDisabled` state is gone. App reassembled from source, JSX
  re-verified, hooks block still byte-identical (the examples gate proves it).
- Phase H, done:
  - **ADR-0032 → accepted**, with §4 REWRITTEN to describe what actually shipped: the owner's
    unix-socket decision had been folded into the task file but §4 still described TCP
    host+port admission. An accepted ADR describing a design the code does not implement is
    worse than a proposed one. The Phase-C "open: consider UDS" item is closed as decided.
  - **ADR-0033 → accepted, with the split stated in the status line itself**: the gate is
    built and enforced; the arming surface is deferred. Added the in-memory residual and the
    `slot`/`body` confirm-seat note (the absence of `slot` is what structurally keeps a grant
    off the wizard's probe — the shared-singleton hazard §3 names, closed by data shape rather
    than by a check someone could forget).
  - **Threat delta** `docs/security/threat-model-delta-whatsapp-sidecar.md` — new surface,
    guards per link, and six accepted-and-unmitigated residuals. The third-party-consent one
    is called out as the residual a reviewer should weigh most heavily: those people never
    consented, are not Snug users, and cannot opt out.
  - **Spec-changelog**: internal-draft entry (zero schema bytes; `connection-requirement` is
    outside `json-schemas.ts` SOURCES, same line as `lanHost`). Records the `linked_device`
    kind, the sidecar contract module, and the confirm-seat shape — including that adding a
    kind changed the inferrer's PROMPT, since `AUTH_KINDS` is injected into it verbatim.
  - **Code map**: new linked-device capability row; starter row 10 → 11 folders, 5 → 6
    manifests, examples test count 147 → 188.
  - **Next-steps**: the arming-surface follow-up added with both options and their tradeoff
    pre-scoped; the 2026-08-12 BYOK CORS advisory updated (this task built the precedent it
    anticipated); Twin added to the owner hardware-verification list, ToS warning first.
  - **Fixed a doc gap found on the way**: `docs/decisions/README.md`'s index stopped at 0029
    — 0030 and 0031 had never been added either. All four rows added, so the index stops
    silently under-reporting what exists.
- Verified: root `turbo run test --force` **23/23, 0 cached**; `cargo check --lib` clean;
  cargo **64**. Counts at close: protocol 329 · auth 813 · playground 1121 · examples 188 ·
  whatsapp-sidecar 18 · desktop 124.
- **Task status: Gate 5 complete for the shipped scope.** What remains is owner-owned, not
  agent-owned: the macOS hardware gate, the Twin pairing journey, and the deferred arming
  surface. Recommend `/close-session` next, then the PR.

### 2026-08-17 — claude — macOS shell gate re-run on hardware: GREEN

- **Correction to my own handoff framing.** I had listed the macOS gate as an owner
  verification. It is not: `pnpm --filter desktop gate` is SELF-DRIVING (`tauri-driver` has
  no macOS support, so the driver builds the debug shell with
  `--features tauri/custom-protocol`, launches it, and the webview harness runs every check
  inside the real WKWebView, writing one JSON verdict). No hardware interaction is needed —
  only a machine that can build the crate. Ran it here.
- **Result: GATE GREEN** — 28 checks + 13 journey steps, all present and passing. First run
  since `sidecar_ctl`/`sidecar_fetch` landed, and it could not have run before the
  2026-08-16 Cargo repair because the crate did not build.
- **The verdict this task existed for**, now proven in a real WKWebView rather than jsdom:
  `ipc-sidecar-fetch-refused` — *"keyless `sidecar_fetch` through `webkit.messageHandlers.ipc`
  resolved no callback, and the invoke key never reached the subframe — key-gated per
  command."* Reaching that command from app code means reaching the process holding the
  user's linked-device session, so this is the C2 half of ADR-0032's custody story. Its
  sibling `ipc-lan-fetch-refused` also passes, and the two are independent per-command
  checks (amendment-16 discipline), so neither borrows the other's verdict.
- Also confirmed green on this run: `ipc-tauri-internals-absent` (the Windows D8 failure
  mode, correctly absent on macOS), the 14 CSP checks, and both persistence-flush legs.
- **Still genuinely owner-owned** (no automation can cover them): the Twin pairing journey
  against a real WhatsApp account — helper spawns, QR renders, phone links,
  verify-before-claim passes, a thread analyses, one manual Reply is confirmed and delivered
  — and the ToS/ban risk decision that precedes it. Windows stays deliberately red (D8).

### 2026-08-17 — claude — 🔴 GAP FOUND while preparing the owner's manual test: Phase C is INCOMPLETE

- **The pairing journey cannot be run today, and my previous entries implied it could.**
  Found by checking what the shell actually spawns (`helper_entry` →
  `~/Snug/helpers/whatsapp-sidecar/index.js`) against what the package can produce.
- **What is missing from `apps/whatsapp-sidecar`:**
  - **No entry point.** `package.json` declares `main: dist/index.js` and a bin
    `dist/cli.js`; NEITHER `src/index.ts` NOR `src/cli.ts` exists. The manifest names files
    that were never written — a claim about another artifact, unverified, which is the exact
    failure lessons.md:69 warns about and which this task already recorded itself committing
    once (B3).
  - **No unix-socket server.** Nothing calls `createServer`/`listen`. The router is a pure
    `handle(request)` function with no transport in front of it, so `sidecar_fetch` has
    nothing to dial.
  - **No real `WaSocket` implementation and no `baileys` dependency.** Every reference to
    `makeWASocket`/`useMultiFileAuthState` is in a COMMENT. The only implementation is the
    scripted fake in `__tests__`. The plan's own Phase C line names
    `src/{server,routes,session,store}.ts`; what shipped is `{router,store,wa-socket}.ts` —
    **`server` and `session` were never written**, and the Phase C journal entry reported the
    phase complete without noting it.
- **Why the suites are all still honestly green.** The 18 sidecar tests test the router's
  REFUSALS against a scripted fake, which is what they claim to do and what they should do.
  Nothing anywhere asserts that the package produces a runnable process — no test imports an
  entry point, and the Rust side is tested against its own admission logic, not against a
  live helper. So this is not a broken test; it is **a hole no test was ever pointed at**,
  which is precisely the shape the task's own repeated lesson keeps naming (a green suite
  says nothing about code no test calls — Phase G, `decideSidecarFetchRefused`).
- **What DOES work and is unaffected** (so the gap is scoped, not total): the protocol kind
  and contract, the registry entry, the router's refusals, the Rust admission +
  `sidecar_ctl`/`sidecar_fetch`, the C2 gate row (hardware-verified green today), the wizard
  flow's state machine and screens, the starter app, and the standing gate. Everything
  between the webview and the socket is real; what is absent is the process on the far end.
- **Corrected task status: Phase C is NOT done.** The remaining work is a real Phase C.2:
  `src/index.ts` (unix-socket HTTP server binding `~/Snug/whatsapp-sidecar.sock` at 0600,
  parsing the request into the router's shape, honouring the 1 MiB cap), `src/cli.ts`
  (argv/env nonce + socket path from `sidecar_ctl`), `src/baileys-socket.ts` (the real
  `WaSocket` behind the seam — this is what the seam was FOR), the `baileys@7.0.0-rc14`
  dependency, and an install step putting the built helper at `~/Snug/helpers/`.
- Next step: owner decides whether to commission Phase C.2 now or land the PR with the
  helper explicitly marked unimplemented. **Nothing about the pairing journey should be
  described as testable until C.2 exists.**

### 2026-08-17 — claude — Phase C.2: the helper is real and RUNS (owner commissioned it)

- Done: `src/server.ts` (unix-socket HTTP), `src/baileys-socket.ts` (the real `WaSocket`),
  `src/index.ts` + `src/cli.ts` (entry points), `install-helper.mjs`, and the
  `baileys@7.0.0-rc14` pin. Sidecar tests 18 → **40**.
- **API re-verified from the published tarball, not from the earlier journal's claim.**
  `7.0.0-rc14` resolves `libsignal` from the REGISTRY (`^6.0.0`), which was the whole reason
  for the pin over the 6.x git-URL line. Confirmed present: `makeWASocket` default export,
  `useMultiFileAuthState`, `connection.update.qr`, `messages.upsert`,
  `messaging-history.set`, and — the one this design leans on —
  `messaging-history.status.explicit`, documented in the .d.ts as *"progress === 100 was
  received from the server. when false, completion was inferred via timeout"*. Also found
  `sendMessage` returns `WAMessage | undefined`, so the adapter REFUSES on an undefined
  return rather than reporting a send that never happened.
- **THREE bugs that only a running process could reveal.** All three had green suites above
  them, and all three are the same lesson in different clothes: every layer individually
  correct, the seam between them never exercised.
  1. **Percent-encoded JIDs resolved to nothing.** The starter builds
     `/chats/${encodeURIComponent(jid)}/messages`; the Rust side decodes only to REASON about
     traversal and deliberately forwards the ORIGINAL path (decoding before forwarding would
     let `%2f` smuggle a separator); and the router split segments WITHOUT decoding. So the
     app asked for `a%40s.whatsapp.net`, the router looked that up literally, found nothing,
     and returned a perfectly well-formed 404. Nothing was red. Fixed in the router (the seat
     that owes it), decoding PER SEGMENT after splitting so an encoded separator can never
     introduce a segment, and refusing an undecodable segment rather than falling back to raw
     bytes. Three tests, one of them the malformed-escape refusal.
  2. **Socket paths silently truncate.** `sun_path` is ~104 bytes and node does not reject a
     longer path — it TRUNCATES, binds, and reports success. The first live run created a
     socket literally named `w`, then failed `chmod` on the intended path. The unit tests
     could never have caught it: `mkdtemp` paths are short. Now refused up front with a named
     error. (`~/Snug/whatsapp-sidecar.sock` is 39 bytes, so production had room; the guard is
     for an unusual HOME or a future relocation.)
  3. **The installed helper would not start at all** — twice, each for its own reason, and
     each invisible from inside the workspace. No `package.json` in the target, so node
     walked up to `~` looking for one; then `protobufjs` missing, because copying pnpm's
     `node_modules` yields a symlink farm of DIRECT deps only (baileys present, its own deps
     absent); then `z.url is not a function`, because npm resolved an older zod for the
     vendored protocol package, which needs v4. The installer now writes a real
     `package.json`, runs a genuine production `npm install`, pins zod at the protocol
     package's own range, and vendors the built workspace protocol package.
- **Verified by running it, not by reasoning about it.** Built, installed to
  `~/Snug/helpers/whatsapp-sidecar/`, launched with the EXACT command and env `sidecar_ctl`
  uses (`node …/index.js`, `SNUG_SIDECAR_SOCKET`, `SNUG_SIDECAR_NONCE`), then driven over the
  real unix socket:
  - socket created `srw-------` — **0600**, the whole access-control story for a UDS;
  - `/pair/qr` and `/chats` **401** without credentials, `/pair/*` included;
  - `POST /pair/start` with the nonce → 200, and `GET /pair/qr` returned a **real 277-char QR
    payload from WhatsApp's servers over a live WebSocket** — scannable;
  - `/chats/../pair/status` → 404 (traversal refused);
  - clean shutdown removes the socket file.
- The session-key directory is created but EMPTY until someone scans, which is correct: keys
  are written on link. C1's custody claim is now observable rather than asserted.
- **Deliberately still not done**: bundling the helper into the app (out of scope by the
  task's own list; v1 spawns system `node`), so `install:helper` is an owner/dev step and is
  documented as one.
- Verified: sidecar **40**; root `turbo run test --force` **23/23, 0 cached**; cargo **64**.
- **The pairing journey is now runnable.** Owner steps: `pnpm --filter whatsapp-sidecar build
  && pnpm --filter whatsapp-sidecar install:helper`, then the desktop app → connect the
  WhatsApp connection → scan → pick a thread → analyse → one manual Reply.

### 2026-08-17 — claude — owner hit "the helper could not be started": the GUI's node is not the shell's

- **Owner report**: clicking "start linking" in the wizard gave *"the WhatsApp helper could
  not be started"*. Reproduced and root-caused; **two defects, and the second is why the
  message was worse than useless.**
- **Cause.** `sidecar_ctl` spawns `Command::new("node")`, which resolves against the PATH the
  **GUI app** inherits — on macOS a minimal one that does NOT include nvm. The owner's
  machine resolves that to `/usr/local/bin/node`, a 2023-era **v18.18.0** x86_64 binary owned
  by root; their nvm (and my terminal, which is why every earlier run worked) has v22.13.1.
  `baileys` declares `engines.node >= 20`, and its `lru-cache` imports `tracingChannel` from
  `node:diagnostics_channel`, which v18 does not export — so the helper died on its first
  import, every time, instantly.
- **Defect 2, the one that hid it**: `spawn()` reports success the moment the process EXISTS.
  A child that dies a millisecond later was invisible, so the shell recorded the helper as
  running and the wizard blamed the spawn. The user was told the helper could not start when
  it had started fine and then exited — **an error pointing at the wrong thing costs more
  than no error at all.**
- **Fixed, tests first (6 new cargo tests, 64 → 70):**
  - `node_version_preflight` asks the SAME bare `node` the spawn will use (asking a
    separately-resolved path would vouch for the wrong binary — that IS the bug) and refuses
    below Node 20 with a message naming the version found, the version needed, and what to do
    about it. An unparseable version is refused, never assumed new enough.
  - `helper_entry_refusal` refuses before spawning when the helper is not installed, naming
    the expected path and the install command. Packaging is out of scope, so "not installed"
    is an ordinary state that deserves an instruction.
  - The spawn now waits 600 ms and `try_wait()`s: a child that already exited becomes *"the
    WhatsApp helper started and then stopped"* plus its last three stderr lines (capped at
    400 chars, kept off every route).
  - `MIN_NODE_MAJOR` is pinned by a test against baileys' own `engines.node`, so a future
    floor rise fails loudly instead of reaching a mystifying import error.
- **This is the ADR-0032 out-of-scope packaging decision showing its teeth.** v1 deliberately
  spawns the system `node`; the consequence is that the runtime is whatever the user's GUI
  PATH finds, which is frequently not what their terminal finds. The preflight makes that
  legible rather than fatal, but it does not make it go away — bundling a known-good runtime
  is the real fix and remains out of scope by the task's own list.
- Verified: cargo **70**. Owner still needs a Node 20+ that the GUI can see before the
  pairing journey can proceed (their nvm v22 is invisible to the app).

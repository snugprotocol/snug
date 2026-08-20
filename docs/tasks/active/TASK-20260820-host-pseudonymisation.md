# TASK-20260820-host-pseudonymisation: Host-enforced pseudonymisation backstop on the LLM egress seam

- **Status**: in-progress (plan owner-approved 2026-08-20; directory lifecycle: revoke-wipe)
- **Owner**: Jeetu
- **Risk tier**: **High** (owner-set, interview 2026-08-20) — constructs the security boundary threat-model R-9 names the residual a reviewer weighs most heavily; High obligations apply: tests first incl. negative tests, fresh-context AI review of this plan before implementation (**done 2026-08-20, findings folded in — see Decisions**), journal self-sign-off
- **Branch**: `feat/TASK-20260820-host-pseudonymisation`
- **Packages touched**: `apps/playground` (egress scrub + ingress harvest + provider-lane scrub), `packages/db` (persisted identity directory accessors), docs (`threat-model.md`, whatsapp delta, next-steps, code-map). **NOT touched**: `packages/protocol` (no schema change → no spec-sync), `packages/auth`, `packages/runner`, `examples/whatsapp/app.html` (its scrub stays — defense in depth)
- **Spec impact**: none (no protocol schema change; envelope `state` stays `z.unknown()`)
- **Related**: threat-model R-9 (`docs/threat-model.md:281-293`), `docs/security/threat-model-delta-whatsapp-sidecar.md`, ADR-0034, ADR-0032, ADR-0031 (provider chat lane), ADR-0019, next-steps 2026-08-20 item (1)

## Spec (what & why)

Third-party pseudonymisation — the scrub keeping other people's names, jids and phone
numbers out of LLM-bound payloads — currently exists only inside the sandboxed example app
(`examples/whatsapp/app.html:495-700`). Threat-model R-9: it is an app-layer convention,
not a boundary; the host performs no scrub of app-supplied LLM payloads; any other app
holding an approved sidecar connection can forward raw names/numbers to a model; and the
shipped app's copy is rewritable by the feature lane (the weakest write gate).

This task adds a **host-enforced egress backstop** (owner-chosen shape, interview
2026-08-20, over "full host takeover" — coverage is identical because both can only redact
identities the host has observed plus the jid/phone primitives; the backstop needs no C3
schema change, no reverse-map surface, no host-side label store, and leaves the shipped
app's stable P-label UX untouched as defense in depth). **Framing (carried into the docs
rewrite): the backstop is anti-default and anti-naive, not anti-adversarial** — it stops
raw identities flowing by default and by sloppiness; a deliberately obfuscating app
(homoglyphs, base64, numeric smuggling) still defeats substring redaction, and R-9's
replacement text must say so.

1. **Ingress harvest.** The host observes sidecar response bodies at the one platform seat
   every sidecar read already crosses (`sidecarAppFetch`, `apps/playground/src/state/net.ts:248`)
   and extracts identities (chat/participant names ≥ 3 chars, jids) into a persisted
   **identity directory** in UserDb (owner-chosen over session-memory: closes the
   replay-from-app-DB-in-a-fresh-session gap). Extraction is the scrub — known body shapes
   only, field-by-field (precedents: `syncStateFromChatsBody`, `cleanHints`). The in-memory
   directory updates **synchronously before the body is handed back** (no first-wire race);
   persistence may lag. The wrapper reads the **response body only** — never the argument
   tuple, which carries injected credential headers (C1 hygiene).
2. **Egress redaction — app-message lane.** Before any LLM-bound app-message wire from an
   app whose approved connection ceiling contains `SIDECAR_SYMBOLIC_HOST` (owner-chosen
   scope: exactly R-9's population; predicate is the **connection fact**, never platform
   seat presence, and is evaluated **per send**, not at transport creation) reaches a
   provider — BYOK **and** subscription `/invoke`, wrapped at the transport seam both paths
   share — the host parses the envelope and redacts **every string field AND every object
   key across the whole parsed envelope** (`state`, `payload`, `action`, `responseSchema`,
   ids — a well-formed `responseSchema` must not be an in-band smuggling channel):
   (a) every directory identity, case-insensitively, name identities word-boundary-matched,
   longest-first, as one compiled alternation pass → `[contact]`; (b) jid pattern →
   `[contact]`; (c) digit runs ≥ 7 → `[number]`. P-labels (`P\d+`, `YOU`) are never
   touched. A wire that fails `parseAppRequest` is **unescape-normalised (`\uXXXX` → chars)
   then redacted as a raw string** — malformed envelopes must not become the weaker path.
   If the directory cannot be read at send time the send **fails closed** with a named
   refusal (never raw-to-provider, never silent pattern-only degradation).
3. **Egress redaction — provider chat lane (review blocker 2).** ADR-0031's agent loop
   returns sidecar tool-result bodies to the model raw today
   (`providerTools.ts:195-212`). The same redaction module is applied to **sidecar-class
   results** inside `renderProviderResult` (alongside the existing RFC-1918 scrub) so the
   lane R-9's population reaches the model through without any app-message wire is bound
   by the same boundary.
4. **Response path unchanged.** The model's reply returns to the app verbatim; render-time
   reversal stays the app's concern.
5. **Docs made honest.** R-9 and the whatsapp delta rewritten to the narrower claim with
   the disclosed residuals listed below; next-steps item pruned; the directory named as a
   new persisted third-party-PII **asset** in the threat model.

**Acceptance criteria** (each becomes at least one test):
1. **Harvest:** after a sidecar `/chats` response crosses `sidecarAppFetch`, the directory holds the names+jids from it — observable to an egress scrub **on the very next call** (no settle race) — and holds them after a UserDb export/import round-trip (persistence).
2. **Harvest is the scrub:** the directory stores only identity strings from known fields of known routes — message bodies, previews and unknown keys never enter it; malformed bodies are skipped, not repaired; re-harvesting an unchanged `/chats` body is a no-op write (the 4 s sync-poll re-crosses this seat). The harvest wrapper never touches request arguments/headers (C1 negative test).
3. **Egress — directory hit:** a wire from a sidecar-connected app whose `state` contains a harvested name or jid reaches the adapter with those spans replaced by `[contact]` (asserted at the seam: the string the adapter receives, per the `appTransportRoundTrips` C1-test convention). Case-variant spellings (`PRIYA`) are caught; word-boundary matching leaves `"Newsworthy"` intact when the directory holds `"News"`.
4. **Egress — whole envelope (review blocker 1):** identities placed in `responseSchema` (description/enum strings), `action`, or as **object keys** anywhere in the envelope are redacted the same as `state` fields.
5. **Egress — primitives:** jid-shaped tokens and ≥7-digit runs are redacted even with an empty directory; digit runs < 7 (prices, times) survive. Fixture documents the accepted over-redactions: dash-separated dates (`2026-08-20` → `[number]`) redact — over-redaction is the safe direction.
6. **Scope negative:** an app with no sidecar-ceiling connection has its wire delivered byte-identical — no redaction of names or numbers it is entitled to send.
7. **Cooperating app unharmed:** a wire containing only P-labels/`YOU` and clean text passes byte-identical for canonical `JSON.stringify` wires (parse→re-stringify normalisation is disclosed, not hidden); labels are never rewritten.
8. **No-bypass negatives (High tier):** (a) a wire failing `parseAppRequest` still gets unescape-normalised pattern + directory redaction — including `\uXXXX`-escaped identity spellings; (b) a connection approved **while the transport is already created** is scrubbed on the next send (per-send predicate — the stale-capture defect class `transport.ts:125-179` documents); (c) directory read failure at send time refuses by name, raw wire never reaches the adapter.
9. **Both transports:** the scrub wraps the seam shared by BYOK and server transports — `createServerAppTransport`'s outbound body is scrubbed too.
10. **Provider lane:** a sidecar-class tool result flowing through `renderProviderResult` reaches the agent loop with directory identities and primitives redacted; a non-sidecar provider result is untouched.
11. **Response untouched:** `result.text` containing labels returns to the app unmodified.
12. **Docs:** threat-model R-9 + delta rewritten (host-enforced, anti-naive redaction of observed identities and primitives on both egress lanes) **with disclosed residuals**: numeric smuggling (phone-as-JSON-number; `ts` is legitimately 10 digits), encoding/obfuscation defeat, data-lane replay (app-persisted raw rows reaching the model via `data_read` and classifier RECENT_TURNS), free-text names of non-contacts inside message bodies, and the directory-as-asset lifecycle. Delta-hash row in threat-model §refs updated; next-steps item (1) marked done.

**Out of scope**: removing/altering the app's own scrub in `examples/whatsapp/app.html`;
de-anonymising responses host-side; scrubbing non-sidecar apps' egress; the `data_read`
replay lane (rows are app-shaped — disclosed residual, candidate follow-up task); R-12
(`sidecar_wizard_fetch` gate row); R-8 classifier fencing; harvesting from pump hints
(jid-only, covered by the egress jid pattern); any `packages/protocol` or Rust change.

**Directory lifecycle (owner-decided 2026-08-20): revoke-wipe** — the directory is wiped
when the last sidecar-ceiling connection row is removed. Becomes AC13: after the last
sidecar-ceiling connection is removed, the directory is empty (and stays empty across
export/import); removing one of two sidecar-ceiling rows does NOT wipe.

## Plan

**Design constraints carried from exploration + fresh-context review (both 2026-08-20):**
- Egress choke point: `apps/playground/src/agent/transport.ts:136-141` — host already calls `parseAppRequest(wire)`; wrap at `createAppTransport`/`resolveAppTransport` so BYOK and `createServerAppTransport` (`transport.ts:28`) are covered; wrapper captures `appId` at creation but resolves **predicate + directory per send**.
- Sidecar-connection predicate: the `resolveSidecarSlot` shape (`sidecarLive.ts:317`) — approved row whose ceiling contains `SIDECAR_SYMBOLIC_HOST` (`packages/protocol/src/sidecar-contract.ts:183`). Connection fact, platform-independent (a web session with an imported directory-bearing `.snug` must still scrub).
- Ingress seat: `sidecarAppFetch` (`net.ts:248`) — single desktop seat all three governed callers cross; harvest wraps it in playground; `packages/auth` delivery invariant ("bodies pass through untouched") stays literally true at its layer.
- Redaction operates on **parsed JSON string values AND keys across the whole envelope**; raw-string mode (after `\uXXXX` unescape-normalisation) only for unparseable wires. One compiled longest-first case-insensitive alternation regex per directory snapshot (not per-identity split/join — O(bytes) not O(N×bytes) on 150 KB wires); name identities word-boundary-wrapped.
- App rules carried verbatim: identities < 3 chars never redacted; ≥7-digit dialability floor (`app.html:549-568` reference; `examples/whatsapp-analysis.test.mjs` fixtures portable).
- Harvest coverage rationale (review finding 13): `/chats` is the only name-bearing route — history rows carry jids only (`wa-socket.ts:28-51`), `/events` hints are jid-only; both covered by the egress jid pattern.

**Files, in order (tests FIRST per TDD.md):**
1. `apps/playground/src/agent/__tests__/pseudonymizeEgress.test.ts` — NEW. AC3–AC9, AC11 against the pure module + transport wrapper with a fake adapter.
2. `apps/playground/src/__tests__/sidecarIdentityHarvest.test.ts` — NEW. AC1, AC2 with recorded `/chats` + history body shapes (`apps/whatsapp-sidecar/src/router.ts:197-228`).
3. `apps/playground/src/__tests__/providerTools.test.ts` — EXTEND. AC10 beside the existing RFC-1918 scrub tests (`:303`).
4. `packages/db/src/userdb/__tests__/` — new accessor tests (round-trip, export/import survival, cheap no-op re-add).
5. `packages/db/src/userdb/userdb.ts` — `getSidecarIdentities()/addSidecarIdentities(rows)` (+ `clearSidecarIdentities()` if the owner picks revoke-wipe) over a new KV table (`kvGet/kvSet` pattern, `userdb.ts:1300-1307`); additive.
6. `apps/playground/src/agent/pseudonymizeEgress.ts` — NEW pure module: ported patterns, compiled-alternation directory matcher, deep walk (values + keys), `scrubAppWire(wire, directory)` with unescape-normalised raw fallback, `scrubText(text, directory)` for the provider lane.
7. `apps/playground/src/state/sidecarIdentity.ts` — NEW harvest module: `harvestFromSidecarBody(pathAndQuery, body)`; synchronous in-memory directory + persisted write-behind; wired into `sidecarAppFetch` (response body only).
8. `apps/playground/src/agent/transport.ts` — per-send scrub at the shared seam; fail-closed named refusal on directory read failure.
9. `apps/playground/src/agent/providerTools.ts` — `renderProviderResult` applies `scrubText` to sidecar-class results.
10. `apps/playground/src/state/net.ts` — thread the harvest wrapper around the seat (keep `__sidecarAppFetchForTests` semantics).
11. Docs, same branch: `threat-model.md` R-9 rewrite (anti-naive framing + disclosed residuals + directory asset row) + delta-hash row, whatsapp delta addendum, `next-steps.md` prune, `code-map.md` row.

**Cross-package impact** (playground → db, protocol, auth): `packages/db` additive accessors → run root `pnpm test` (db is widely depended). `packages/auth`, `packages/protocol`, `packages/runner`, Rust untouched. Spec-sync: none.

**Verify (Gate 5):** root `pnpm test`; the new/extended suites; `examples/whatsapp-analysis.test.mjs` still green (app untouched; AC7 pins no double-scrub corruption).

## Decisions & surprises

- **2026-08-20 — Shape: egress backstop over full host takeover** (owner asked for a recommendation): identical observed-identity coverage; no C3 schema churn pre-launch; no reverse-map surface; small choke point with adversarial tests is the stronger security-review story; app scrub retained as defense in depth answers R-9's weakest-write-gate concern.
- **2026-08-20 — Scope: sidecar-connected apps only; directory persisted in UserDb; risk tier High** (owner, interview).
- **2026-08-20 — Fresh-context plan review (High-tier obligation) returned 2 blockers + 7 should-fixes, all folded**: (1) walk the whole envelope, not `state`/`payload` — `responseSchema` was an in-band bypass; (2) the ADR-0031 provider lane delivers raw sidecar bodies to the model with no app-message wire — now in scope via `renderProviderResult`; plus per-send predicate (stale-capture class), fail-closed directory reads, first-wire harvest race, unescape-normalised fallback, case-insensitive word-boundary matching, one-pass alternation, anti-naive framing, directory-as-asset lifecycle (owner decision pending), disclosed residuals list (AC12).
- Scrub operates on parsed JSON fields, never the escaped wire string (a name containing `"` is `\"` on the wire).
- **2026-08-20 — Gate-5 eight-angle diff review found 3 confirmed defects + lifecycle gaps; all folded** (each pinned by a new test): (1) the provider-lane sidecar-class predicate re-spelled the connection-URL grammar — `SNUG-CONNECTION://`/padded spellings EXECUTED as sidecar reads but skipped the scrub; now canonical `parseConnectionUrl` + executor normalization + `isSidecarSlotFact`. (2) The phone pattern rewrote ~35% of real UUIDs inside envelope ids, breaking the model's requestId echo; ids now pass verbatim (disclosed ≤128-char residual channel). (3) An imported `.snug` never scrubbed — import demotes rows to `declared` and the guard required `approved`; the egress population is now the connection FACT in any status (`appHasSidecarFact`), the pump stays approved-only, and the directory deliberately SURVIVES import (Angle G's "wipe on import" was resolved the other way: the replayable app data rides the same import). Also folded: session-scoped memory reset (import/pull/restore/revoke/deleteApp — one user file's contacts can never re-persist into another; a wiped directory stays wiped), `markDirty` moved inside the wipe helper (durability is the wipe's property, not each caller's), `responseSchema` keys/`required` untouched + case-sensitive directory matching there (a contact "Home" must not break a `home` property), raw-fallback commutation test (benign `\uXXXX` data never corrupted), guard moved inside BOTH leaf transports + envelope-appId fallback (uninstalled-starter mode), matcher/directory memoization + poll body short-circuit, jid-pattern parity pin against app.html, digit-sequence over-redaction pinned as documented. **Consciously not fixed** (recorded rationale): wipe's full-scan SELECT on revoke (rare user gesture, hundreds of rows worst case); wizard-command `GET /chats` capability un-harvested (no caller today; comment left at the harvest module); data-lane replay (out of scope, disclosed in R-9); `renderProviderResult` scrub stays a parameter (the cap-ordering rule lives inside the renderer).

## Session journal (append-only, newest last)

### 2026-08-20 — Claude (with Jeetu) — session
- Done: task file; read PROCESS/TDD, threat-model R-9, ADR-0034, app scrub code; fresh-context seam exploration (ingress `connected-fetch.ts:1064` vs egress `transport.ts:136` — not connected; zero host-side pseudonym code); Gate-1 interview (shape/scope/store/tier); Gate-2 plan; branch created; fresh-context adversarial plan review run and folded (2 blockers closed on paper)
- State: plan awaiting owner approval — **no implementation started**
- Next step: owner approves plan + decides directory lifecycle → Gate 3 (tests first)
- Open questions: directory lifecycle (revoke-wipe recommended vs kept-and-disclosed)

### 2026-08-20 (later) — Claude (with Jeetu) — session
- Done: plan approved + revoke-wipe decided (owner). Gate 3: failing tests committed (`c9871b2`). Gate 4: implementation (`fef5c2d`) — db key module + revoke/delete wipe hooks, `pseudonymizeEgress`, `sidecarIdentity`, transport guard, provider-lane scrub, net.ts harvest wiring. Gate 5 verify: playground 1292/1292 (125 files), root `pnpm test` 23/23 tasks, `examples/whatsapp-analysis` 34/34, threat-model checker 139/139 after docs. Docs: R-9 rewritten (anti-naive claim + disclosed residuals + directory named as asset), new §5 invariant row, delta bullets rewritten + hash re-pinned (`080e64034de0`), next-steps item (1) marked done, code-map row added.
- Implementation deviations from plan, all recorded in Decisions: settings-KV instead of new accessors pair (a `snug_` table = spec-normative format change; `app-settings-keys.ts` precedent followed, key single-homed in `packages/db/src/userdb/sidecar-identity-keys.ts`); harvest persistence is ready-gated fire-and-forget (awaiting `getUserDb()` at the seat BOOTS a db — hung `sidecarAutostart`'s db-less contract); phone pattern widened to consume a leading `(`.
- Two stale untracked scratch files (`zzRace*.test.ts`, referencing the long-gone `state/wizard.js`) blocked the playground typecheck; moved to the session scratchpad, not deleted.
- State: implementation + docs complete and green; AI diff review next
- Next step: Gate 5 AI review of the diff → fold findings → self-sign-off → PR
- Open questions: none

### 2026-08-20 (review fold) — Claude — session
- Done: eight-angle AI diff review (/code-review high) ran to completion; 3 confirmed defects + lifecycle gaps folded with 14 new pinning tests (see Decisions). Suites after fold: playground 1303/1303 (125 files), db `sidecar-identity-wipe` 7/7, root `pnpm test` 23/23 (one non-reproducing playground failure in a single root run — did not recur across two subsequent full runs; consistent with the known playground-flake open thread), `whatsapp-analysis` 34/34, threat-model checker 139/139. R-9, §5 row, and code-map row updated to the post-fold truth (fact-population, id passthrough, provider-lane classification, import survival, session reset).
- **High-tier self-sign-off**: I attest the plan was owner-approved before implementation; tests preceded implementation for the original ACs and for every review-fold fix; C1/C2 negative tests exist and pass; no `packages/protocol`, `packages/runner`, or `packages/auth` source was touched; the docs' claims were re-narrowed to match the shipped behavior rather than the other way around.
- State: ready for PR + human review
- Next step: PR; owner review of diff AND task file
- Open questions: none

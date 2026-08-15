# 0016 — Who may propose a connection (the trust ladder)

- **Status:** accepted (owner decision 2026-08-08, recorded 2026-08-08; amended by 0017 — requirement/grant split)
- **Date:** 2026-08-08
- **Task:** TASK-20260807-connection-reachability

## Context

A connection is a credential grant: an approved row in `snug_auth_specs` tying one app to one provider and a frozen host list, after which the connected-fetch executor injects real credentials on that app's behalf. ADR-0014 settles *where credentials live*; this ADR settles the question that comes first — **who is allowed to ask for one**.

The question became live because three separately-correct designs composed into a dead end. AL-08 shipped chat-less starters; AL-04 made connection proposals arrive only as a reviewed builder-LLM directive; the wizard reviews either an existing row or a proposal. Each is sound alone. Together they meant **no app that arrives without a build conversation could ever become a connected app** — a starter's own network call returned `NET_NOT_APPROVED`, the CTA opened an empty manual review, and the user faced hand-typing the provider and every hostname. Nothing was broken; the gap was structural and invisible until a starter needed a credential.

The obvious fix — let the app declare what it needs in its announce frame, and have the host seed an unapproved row — was designed and put through a 3-lens security review **before any code**. It failed with **3 BLOCKERs + 9 MAJORs**. The findings were not bugs in one proposal so much as a map of the real constraints: the registry's host-discard protection is structurally OAuth-coupled and does not exist for static kinds; the announce payload is unbounded where the directive schema keeps its `.max()` bounds; a seeded row would have received a *lighter* review than the identical content arriving by directive; revoke leaves no tombstone, so any re-declaration channel silently reverses a user's revoke; and `providerName` has no charset guard, so a Cyrillic confusable misses the registry while the attacker's string becomes the display name.

That review made the underlying question explicit and unavoidable: **should an app ever be able to propose a connection at all?**

## Decision

**An app may never propose a connection at runtime.** There is no frame, no SDK call, and no announce field through which running app code can ask for a credential grant. Exactly three proposers exist, and the review each receives is fixed:

| Proposer | Channel | Review |
|---|---|---|
| the user | Settings / net-error CTA | manual entry |
| the builder LLM (already reviewed) | chat directive → `resolveWizardIntent` | registry rung light · inference strong |
| the **install act** | starter's `examples/<folder>/connection.json` | **always strong** (field-by-field `spec_confirm`) |

The install-act rung is the one this task added, and it is deliberately the narrowest thing that closes the gap:

1. **The declaration travels with the install, not with execution.** It is a file in the starter's own folder, reviewed as first-party repo content, not a message emitted by running code. There is no re-announce and no re-seed channel.
2. **It is never persisted.** Nothing writes a proposal anywhere. The declaration is resolved on demand and exists only for the lifetime of a wizard session.
3. **Two independent facts must hold**, or no declaration is offered: `install_source` maps to a bundled manifest, **and** the installed HTML matches the bundled starter's — for **both** the pinned factory version **and** the version that actually runs. Requiring the running version is the load-bearing security property: the iframe executes `current_version` and credential brokering keys on `appId`, so vouching for bytes that never run would let an imported DB pair pristine public code with an attacker's payload and collect the approval. Any mismatch is **reported in Settings, never silently withdrawn**.
4. **The review can never be downgraded.** The declaration rides in its own immutable wizard-session field rather than as a provenance value, so no mid-session action — notably the "infer from docs" button — can flip a declaration session onto the light approve-as-is path.
5. **Approval remains the only writer.** The sole non-test `putAuthSpec` call site stays inside the wizard, behind an explicit user approval. A declaration proposes; it never grants.
6. **Manifest trust is scoped and stated.** Manifests are trusted *only* because they are first-party, in-repo, PR-reviewed content gated by the `examples` validate suite. **Before any untrusted declaration channel may exist** (an app-import flow above all), a `providerName` charset/confusable guard and a registry-borrow ban are hard prerequisites, not nice-to-haves.

## Alternatives considered

- **A — app-declared proposal at runtime, hardened.** The announce-frame seam with every review finding designed against. Rejected: it creates a channel whose cadence the *app* controls, and the whole failed-review lineage showed how much machinery is needed to make that safe. Bounded payloads and forced-strong review would have mitigated the known findings, not the class.
- **B — user-initiated from Settings only.** The narrowest surface, and it remains available as a path. Rejected as the *primary* answer: it requires the user to already know the provider, and the registry ladder is structurally OAuth-only, so a static-kind starter strands the user in manual entry — the empty wizard this task exists to eliminate.
- **D — ship starters with a pre-seeded bootstrap chat turn** so the existing directive path works unchanged. Rejected as **trust laundering**: app-authored content would wear `inference` provenance and fabricated chat history, making a declaration indistinguishable from a reviewed builder proposal. It is the smallest diff and the least honest.
- **Do nothing** (leave chat-less apps unable to connect). Rejected: it makes AL-08's starter shelf permanently incapable of demonstrating a connected app, and pushes every credentialed starter back into the builder-only path.

## Consequences

- Starters can ship as genuinely connected apps; the shelf's `connection-demo` proves the full journey end-to-end in a real browser (install → the app's own call → `NET_NOT_APPROVED` → CTA → prefilled strong review → approve → frozen row).
- **A user who edits their installed declaring app loses the guided setup** and falls back to the plain wizard plus a Settings mismatch notice. This is the accepted cost of clause 3 (owner decision, same date): the security property wins. The honest fix — re-vouch on every version write — depends on the revoke tombstone queued to AL-10 and must not be attempted without it. Recorded so it is not quietly reverted by a later session reading only the earlier reasoning, which had this call backwards and shipped a test that blessed the attack shape.
- `packages/protocol` is untouched: no new provenance literal, no persisted-enum widening, therefore no spec-sync and no published-artifact regeneration. The declaration is a playground-local session concept, and the published `app-announce.json` keeps the whole auth surface out until Beta exit.
- The post-revoke re-offer rule is **UX friction, not a security boundary** — nothing persists it, so it dies on page reload. Stated as such in the code and the tests; the real fix is AL-10's tombstone.
- Any future untrusted declaration channel inherits clause 6 as a blocking prerequisite list, cited from `docs/next-steps.md`.
- Trust-ladder summary for readers: `docs/architecture.md` §Who may propose a connection.

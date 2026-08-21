# Threat-model delta — starter versioning and the in-place update channel

- **Task:** TASK-20260820-starter-updates · **ADR:** [0045](../decisions/0045-starter-versioning-and-update-channel.md)
- **Date:** 2026-08-20 · **Written:** 2026-08-21 (TASK-20260821-hardening-polish, P6; extended by that task's docs-only-release fix)
- **Scope:** what an in-place update channel for installed starters adds to the attack
  surface, and what is **accepted and not mitigated**.

> **How to read this.** A *delta*. It assumes the install-act trust rung recorded in
> `architecture.md` ("who may propose a connection") and the app-delete/versioning
> semantics of ADR-0007/0010.

---

## 1. The posture change in one sentence

Installed starter code, which was previously **immutable after install**, can now be
replaced in place from bundled bytes — which makes the shipped bundle a live code path
into apps a user is already running, and makes the *decision to update* a consent
surface that did not exist before.

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **The update act writes new app HTML into a user's file** | Get arbitrary bytes executed under an existing app's identity (its data, its `auth:<appId>:*` credentials, its approved connections) | The bytes come from the **bundled** `examples/<folder>/app.html` — first-party, in-repo, PR-reviewed content gated by the `examples` validate suite. There is no network fetch, no registry lookup, and no user-supplied path in this act. An attacker who can write the bundle already owns the shipped product. |
| **S2** | **`appHash` binds metadata to bytes** | Ship an app.html edit with stale release notes, so the user consents to a description of a different change | The validator recomputes sha-256 over the normalized `app.html` and **fails the suite** unless `starter.json` was released alongside it. The authoring rule is enforced, not requested. (`appHash` is deliberately never read at runtime — it makes the rule enforceable, it is not a runtime integrity check.) |
| **S3** | **The vouch's "factory" set became plural** — the declaration rung requires the newest PINNED version to match the bundle, not v1 | Get an app's guided-connection provenance vouched for bytes that are not running, or pin a hostile row | Fact 2 is unchanged and is the security property: the **running** `current_version` must also match. Forgery still requires controlling both a pinned row and `current_version`; an empty pinned set refuses. `starterDeclaration.ts`, tested with a zero-pin twin. |
| **S4** | **`resetToFactory` flipped MIN → MAX pinned** | Use "reset" to move a user onto bytes they never accepted | Every pinned version is factory content the user consented to at some point (install or an offered update), and the pre-update version stays in the versions panel and is revertable. "Factory" now means the starter you are on. |
| **S5** | **An edited copy can be overwritten** | Destroy a user's own re-authored app under the guise of an update | An edited copy (running ≠ newest pinned) updates only through an explicit confirm; unedited copies are one click. Either way the update lands as a NEW pinned version through `saveAppVersion` — the prior version is retained and revertable, so the act is non-destructive by construction. |
| **S6** | **The version record is a `snug_settings` row** (`starterVersion:<appId>`) in a shared namespace | Leave an orphan that later applies to a REUSED app id | Equality-swept in `deleteApp`'s cascade beside the other three per-app keys, mutation-checked. |
| **S7** | **Docs-only releases** (TASK-20260821): an update whose html is byte-identical, carrying only the authoring wiki | Use a no-op update to seed content into an app's wiki without the user noticing | The seed is **absent-only** — it can never overwrite what the user's own sessions wrote — and the act is still user-initiated with release notes on screen. The offer became reachable for legacy no-row copies in the same change; taking it records the version and the offer does not return. |

## 3. Residual risk — accepted and NOT mitigated

### R-a — Data, credentials and connections survive a code swap, by design
Everything is keyed on `app_id`, never on version, so new code inherits the old code's
approved connections and stored credentials. That is the entire point of an in-place
update (the alternative — delete and reinstall — destroys the user's data), but it does
mean the trust decision is *"do I trust the next version of this app"*, and the answer
is carried by first-party provenance (S1) rather than by anything the user inspects.

### R-b — A changed connection requirement on an APPROVED row waits for the user
The update re-runs the install act's **declared-only** refresh: an `approved` or
`revoked` row is never touched. A starter whose new version legitimately needs a
different requirement therefore keeps running against the old one until the user
re-reviews it in the wizard. Accepted (ADR-0045): silently re-writing an approved grant
is the worse failure.

### R-c — The update offer is a UI element, so a hostile host page could forge one
Unchanged from every other host surface: if the host page is compromised, everything is
(main-model R-1). Noted because "update available" is a phrase users are conditioned to
trust.

### R-d — No downgrade path and no revocation
If a released starter version turns out to be bad, the channel can ship a NEWER version
that fixes it; there is no mechanism to mark a shipped version as bad and pull users
off it. The user's own revert (versions panel) is the only backward move.

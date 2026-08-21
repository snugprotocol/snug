# Threat-model delta — multi-provider BYOK, per-app pins, and the app-lifecycle controls

- **Task:** TASK-20260821-ui-polish · **ADR:** [0046](../decisions/0046-multi-provider-byok-and-app-lifecycle-controls.md)
- **Date:** 2026-08-21 · **Written:** 2026-08-21 (TASK-20260821-hardening-polish, P6)
- **Scope:** what side-by-side provider keys, per-app provider pins, user renames,
  version deletion and the Telepath deep delete add to the attack surface, and what is
  **accepted and not mitigated**.

> **How to read this.** A *delta*. It assumes ADR-0036's per-app model selection and the
> ADR-0014 credential custody model (secrets live in the user's own file, never a
> server vault).

---

## 1. The posture change in one sentence

Two LLM-provider keys can now sit in one file at once and **routing became a resolved
decision per send**, which makes "which third party receives this app's context?" a
question with more than one possible answer — and, separately, the deep delete makes an
app deletion able to **erase a linked-device session on the phone**.

## 2. New surfaces and their defenses

| # | New surface | What an attacker could try | Defense |
|---|---|---|---|
| **S1** | **Two BYOK keys in one file** | Cross-send: route an app's context to provider B using provider A's trust, or send B's key to A's endpoint | Keys are per-provider rows and each adapter is constructed with its own; the resolution result carries provider AND model together, so a mismatch is not representable at the construction site. Custody is unchanged (`snug_secrets`, stripped from hub sync and default exports, VACUUMed). |
| **S2** | **Default-provider resolution** — `providerChoice` row → anthropic-if-keyed → openai-if-keyed → demo brain | Make the tail of the ladder silently pick a provider the user did not intend, especially after a key is deleted | The ladder is one function, read **per send** at every adapter-construction site (transport, builder, the inference ladder) — a captured provider would freeze a mid-session pin. A pin whose key was later deleted routes **honestly** and the selector marks "(key missing)"; it is never silently re-routed to the other provider. |
| **S3** | **Per-app pins in a shared settings namespace** (`appProvider:<appId>` beside `appModel:`) | Leave an orphan that later applies to a REUSED app id | Both keys are equality-swept by `deleteApp` (four one-per-app keys now), pinned by test. Inheriting remains an ABSENCE, not a copy, so an unpinned app follows the default rather than freezing at whatever it was the day it was opened. |
| **S4** | **User renames** (`appRenamed:<appId>`) | Have an app rename ITSELF to impersonate another app in the user's own list, or clobber a user's chosen name via the announce frame | The rename marker is a host-side fact; the run header prefers the DB-backed app-meta store over the announce frame, with an announce-clobber guard at both altitudes and unique display names. An app cannot forge the marker — it has no frame that writes it. |
| **S5** | **Version deletion** (`deleteAppVersion`) | Delete the version a security property depends on — the factory pin the declaration vouch reads, or the running version | Guarded: unknown → refuse, `VERSION_PINNED` refuses ALL pins, `VERSION_CURRENT` refuses the running one. The vouch's inputs are therefore undeletable through this path. |
| **S6** | **The Telepath deep delete** — deleting the last sidecar-fact app performs a full device unlink (`POST /session/forget`, then `sidecar_ctl("forget")` as the Rust disk backstop) | Trigger a destructive unlink from a surface that should not have it; or leave the session store half-wiped so a later write resurrects it | Fires only after the app-delete cascade commits, and only when **no other app** holds a sidecar fact (`appHoldsLastSidecarFact` vetoes). The wipe is guarded by a persist **TOMBSTONE** set before it, checked by every writer — the exit flush and a logout-driven `creds.update` would otherwise re-write the store into the wiped directory. Tested by invoking the REAL registered `'exit'` listener, not by letting timers elapse. |

## 3. Residual risk — accepted and NOT mitigated

### R-a — More keys in one file is more to lose from one file
Two provider keys instead of one raises the value of an unprotected `.snug` file. The
mitigation is the file-encryption delta, and it is opt-in — so this residual is real for
any user who has not taken the protection offer.

### R-b — The deep delete is irreversible and reaches OFF the machine
It ends a WhatsApp linked-device session: re-linking requires a fresh QR scan on the
phone. That is the honest meaning of "delete this app" for a linked-device app, and it
is what a user asking to remove Telepath almost certainly wants — but it is the only act
in the product whose blast radius extends to a third-party account's device list. Named
in the delete confirmation copy, not only here.

### R-c — A keyless pin is disclosed, not prevented
An app pinned to a provider whose key was later deleted routes to the demo brain and
says so in the selector. Deliberate (an automatic re-route would send an app's context
to a provider the user never picked for it), but a user who ignores the marker can be
confused about why answers look canned.

### R-d — Provider choice does not change what the provider receives
Routing to a different vendor changes *who* gets the context, never *what* is in it. The
C1 boundary (no credentials to the model) and the R-9 pseudonymisation backstop apply
identically on both lanes; nothing here narrows what an app-scoped turn discloses.

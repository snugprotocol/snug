# 0052 — Explicit user-initiated feedback channel (amends ADR-0013)

- **Status:** DRAFT — pending owner plan approval
- **Date:** 2026-08-22
- **Task:** TASK-20260822-feedback-loop

## Context

The playground (web + desktop) ships with no accounts, no Google SSO, and — per ADR-0013 —
a hosted instance that is static files with zero backend, where "no telemetry endpoint" is a
named consequence. That doctrine leaves end users with **no path to tell us anything**: when
an app breaks, a build fails, or the connection wizard can't connect, the only channel is
GitHub, which serves contributors, not non-technical users. The internal roadmap (B6)
sketched "in-app report/suggest → GitHub Discussions (no telemetry)", which forces every
reporter onto github.com and cannot carry structured diagnostics.

ADR-0013 also says any growth of a backend is "a 2.0-era question with its own ADR — the
default answer is no." This is that ADR, invoked deliberately by the owner (2026-08-22),
with the narrowest amendment that preserves what ADR-0013 actually protects.

## Decision

1. **The hosted playground stays static (ADR-0013 §1–§2 unamended).** No backend grows on
   the playground origin. What is added is a **separate, Snug-operated receiver** — a
   Cloudflare Worker + D1 at `feedback.snugprotocol.org` (source in `apps/feedback`,
   deployed only on an explicit owner ask, like the website) — that accepts **explicitly
   user-initiated** submissions.
2. **Nothing is ever automatic.** No crash auto-reporting, no analytics, no background
   pings, no fetch on load. The ONLY egress to the feedback origin is a user pressing Send
   after a **review-before-send** screen showing the exact payload that will be
   transmitted. The "we collect nothing" landing/README claims remain true as claims about
   automatic collection; their wording is not weakened by this ADR.
3. **Anonymous by default; email optional.** No account, no client identifier, no
   fingerprinting. An optional "email me back" field exists on every form, default empty;
   when empty, no email key appears on the wire.
4. **Payloads are scrubbed and capped.** Diagnostics and comments pass a credential-shaped
   scrub (the connected-fetch scrubber family) BEFORE both the preview and the wire — the
   preview shows post-scrub bytes, so what the user reviews is what leaves. Hard size caps
   apply worker-side and client-side. This is a new egress surface for credential-shaped
   prose (threat-model R-24 territory) and the scrub is best-effort, not proof — the
   review screen is the honest mitigation.
5. **Three v1 surfaces, all host-page-only (C1/C2 untouched — app iframes gain nothing):**
   inline "report this" affordances beside existing error surfaces (build failure, wizard
   connect failure, app run errors, userdb load failure) pre-filled with what the surface
   already displays; one unobtrusive general feedback / feature-request launcher; and a
   per-app 👍/👎 on installed/starter apps carrying app name + starter version only.
6. **Abuse posture v1:** worker-side per-IP rate limiting, strict schema validation, size
   caps, honeypot field. Turnstile is deliberately deferred — it would load a third-party
   script into a page that today loads nothing, for a threat (feedback spam) whose blast
   radius is one D1 table.
7. **Google SSO / hub login UI is flag-gated, default off.** A `hubAuth` platform
   capability (web default from a build-time env flag, desktop `false`) gates the auth
   probe and both sign-in surfaces. The deployed playground shows no sign-in; self-hosters
   who follow the SSO runbook enable the flag at build time. The server-side OIDC code is
   unchanged — the SaaS/spec surface stays intact.
8. **Supersedes roadmap item B6's shape** (GitHub-Discussions-only): the in-product channel
   is this one; GitHub remains the contributor channel.

## Alternatives considered

- **Firebase Firestore (anonymous auth / open rules)** — works without user Google
  sign-in, but ships a Google dependency in a product whose pitch is "private, no Google",
  and the write path is public-config spam-able (App Check raises, doesn't close). Rejected.
- **Extend `apps/server` with `/feedback`** — requires deploying and hardening a server
  that currently has no authorization, precisely what ADR-0013 exists to avoid. Rejected.
- **GitHub Discussions/Issues deep-link (roadmap B6)** — zero backend, but excludes
  non-technical users (account wall), carries no structured diagnostics, and publishes
  every report publicly. Kept as the contributor channel only.
- **Auto crash reporting with opt-in setting** — rejected outright: a standing consent to
  future unseen payloads is exactly what review-before-send exists to avoid.

## Consequences

- The repo gains a fourth deployable (`apps/feedback`); turbo/`apps/*` pick it up. Deploy +
  DNS are explicit owner asks recorded in the task journal (PROCESS.md release rules).
- The privacy story gains a sentence, not an asterisk: "we collect nothing automatically;
  feedback exists and sends only what you approve." A deploy-time content pass may add
  that sentence beside the three "no telemetry" claim sites (README, quickstart, download).
- A new outbound POST precedent exists for the host page. Any future automatic egress
  cannot cite this ADR — clause 2 is the boundary.
- The launch flip checklist gains: deploy worker, wire `feedback.snugprotocol.org`, verify
  CORS against the playground origin.

# 0052 — Launch feedback channel: GitHub deep-links, no hosted receiver

- **Status:** DRAFT — pending owner plan approval
- **Date:** 2026-08-22
- **Task:** TASK-20260822-feedback-loop

## Context

The playground (web + desktop) ships with no accounts and — per ADR-0013 — a hosted
instance that is static files with zero backend, where "no telemetry endpoint" is a named
consequence and any backend growth "is automatically a 2.0-era question with its own ADR
— the default answer is no." End users hitting an error today have no in-product path to
report it; the internal roadmap (B6, Beta milestone) sketched "in-app report/suggest →
GitHub Discussions (no telemetry)".

The owner first commissioned a hosted anonymous receiver (Cloudflare Worker + D1,
`feedback.snugprotocol.org`, review-before-send), then asked for a fresh evaluation
against the project's goals. That evaluation reversed the call, and this ADR records both
the decision and why the hosted option lost.

## Decision

1. **No hosted feedback receiver ships at launch. ADR-0013 stands unamended.** The
   "we collect nothing" claim keeps its strongest form — verifiable by the absence of any
   endpoint — through the launch window where it does the most work.
2. **In-product feedback is GitHub deep-links** (roadmap B6's shape, promoted from Beta
   to now because the UI is cheap once designed): inline "report this" affordances at
   existing error surfaces and one quiet general feedback entry, each assembling a
   **prefilled GitHub URL** — the issue forms' field-id query params
   (`what-happened`, `environment`, `area`; `problem`) for bugs and feature requests,
   Discussions for open-ended feedback. The user reviews on GitHub's own compose screen
   and submits there; Snug operates nothing and receives nothing.
3. **Preview before navigation.** Opening a prefilled URL transmits its query string to
   GitHub, so the affordance first shows a small in-product preview of exactly what will
   be prefilled; navigation happens only on the user's confirm (new tab on web,
   system browser on desktop). Prefill content passes a credential-shaped scrub and a
   hard size cap before assembly. Nothing is ever sent or opened automatically.
4. **No ratings channel.** Per-app 👍/👎 was cut with the receiver — without a backend it
   has no home, and at launch scale stars/issues/HN are the rating system.
5. **Google SSO / hub login UI is flag-gated, default off.** A `hubAuth` platform
   capability (web default from a build-time env flag, desktop `false`) gates the auth
   probe and both sign-in surfaces, making the already-true-by-construction absence on
   static deploys structural. Server-side OIDC code is unchanged — the SaaS/spec surface
   stays intact for implementors.
6. **The hosted channel is parked, not killed.** Revisit at 1.1 ("Alive & listening")
   only on evidence that non-GitHub reporters are actually being lost. Its full design
   (Worker + D1, anonymity, optional email, review-before-send, Turnstile deferral) lives
   in this ADR's git history (first committed draft) and the task file.

## Alternatives considered

- **Hosted Cloudflare Worker + D1 receiver** (the first draft of this ADR) — rejected for
  launch: dilutes the verifiable zero-endpoint claim precisely when it matters most;
  serves a non-GitHub-user persona that barely exists for a pre-launch developer-audience
  reference implementation; adds a deployable + spam surface to a solo-dev launch already
  carrying conditions; inverts the roadmap's own sequencing (B6 at Beta, feedback response
  at 1.1). Anonymous submissions are also low-quality: no repro, no follow-up path.
- **Firebase Firestore (anonymous auth / open rules)** — works without user Google
  sign-in, but a Google dependency in a "private, no Google" product plus a
  public-config spam-able write path. Rejected.
- **Extend `apps/server`** — requires deploying and hardening a server with no
  authorization; precisely what ADR-0013 avoids. Rejected.
- **`mailto:` fallback for account-less reporters** — rejected: leaks the reporter's
  email by construction, clunky, and unmeasurable benefit.

## Consequences

- Zero new infrastructure; the repo's public issue forms and Discussions become the one
  feedback funnel, with the in-product affordances as the on-ramp.
- Reporting requires a GitHub account — accepted for the launch audience; the 1.1
  revisit owns the day this filters out real users.
- While the repo is private, the deep links 404 for non-collaborators — the same
  designed quiet state as `/download` (ADR-0047); they go live at flip-public with no
  code change.
- The prefill query string is a small egress-on-click to github.com; the preview-confirm
  step (clause 3) is what keeps "nothing leaves without your say-so" true.

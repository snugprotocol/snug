# Security Policy

Snug's security claims are meant to be falsifiable. The two load-bearing ones:

- **C1 — Token boundary.** Credentials never enter an app iframe, never reach the LLM, and never reach an app publisher. In the current architecture every secret lives in `snug_secrets` inside the user's own SQLite file — stripped from sync pushes and default exports (and VACUUMed so deleted values don't linger in free pages).
- **C2 — Sandbox integrity.** App iframes run `sandbox="allow-scripts"` only (never `allow-same-origin`), with `connect-src 'none'` for app-originated traffic and a fixed CDN allowlist. LLM calls originate from the host page only — an app has no network of its own.

Anything that makes either claim false is a critical finding, and we want to hear it.

## Reporting

Preferred: [GitHub private vulnerability reporting](https://github.com/snugprotocol/snug/security/advisories/new).
Also fine: **security@snugprotocol.org**.

Please include a reproduction — a Playground sequence, a single-file app HTML, or a failing test is ideal. Please don't open public issues for suspected vulnerabilities.

## What to expect (honest numbers — this is a solo-maintained project)

- Acknowledgment within **3 business days**.
- Initial assessment (in scope? severity?) within **14 days**.
- Confirmed C1/C2 breaks jump the queue ahead of all feature work; we ask for coordinated disclosure of up to **90 days**, and will usually ship much faster.
- No bug bounty. Credit in release notes and the repository's security acknowledgments unless you prefer anonymity.

## Scope

**In scope**

- Escaping or weakening the iframe sandbox (C2): executing with same-origin privileges, reaching the network from app code, loading from outside the CDN allowlist.
- Breaking the token boundary (C1): extracting anything from `snug_secrets` into an app, an envelope payload, an LLM prompt, a sync push, or a default export.
- Envelope-boundary validation gaps in `packages/protocol` / `packages/runner` (frames that bypass zod validation, smuggle capabilities, or confuse the bridge).
- The reference server (`apps/server`): `/invoke`, session/CSRF handling, `/userdb` compare-and-swap endpoints, artifact cache.
- Prompt-injection **with a boundary consequence** — LLM output or app content that causes the host to violate C1/C2. (Prompt injection that merely makes the LLM say something silly inside its existing permissions is a quality issue, not a security one.)
- The credential-handling layer (`packages/auth` and the `snug_auth_specs` storage in `packages/db`): defeating the per-app host-allowlist freeze, the OAuth flow binding, or the credential store's custody rules is in scope **today**. The connected-fetch injection/scrubbing runtime is landing next and is in scope from its first shipped commit; design-level reports against the documented model are welcome before then.
- Design-level flaws in the protocol itself — report here or against [`snugprotocol/spec`](https://github.com/snugprotocol/spec); same address either way.

**Out of scope**

- Vulnerabilities in LLM providers, browsers, or OS/WebView internals (report upstream; we'll mitigate where we can).
- A user deliberately exporting **with secrets included** or pasting their own key into an unrelated malicious site.
- Denial of service against your own browser tab or your own self-hosted server.
- Infrastructure misconfiguration of third-party self-hosted deployments.
- Social engineering of the maintainer, and anything requiring an already-compromised machine.

## Threat model

A full written threat model is landing at `docs/threat-model.md`. Until it merges, the hard constraints in [`docs/conventions.md`](docs/conventions.md) are the authoritative statement of what the system promises.

## Safe harbor

We consider good-faith security research under this policy **authorized**, and will not pursue or support legal action for it. Good faith means: stay within scope, test against your own local instance or your own data (the hosted Playground is static and client-side — everything reproduces locally), don't access or destroy other people's data, don't degrade service for others, and give us the coordinated-disclosure window above. If you're unsure whether something is in scope, ask first — same address.

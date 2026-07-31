# Security Policy

Snug's core security property is the **token boundary rule**: credentials and tokens never enter the app iframe, never reach the LLM, and never reach an app publisher. The iframe sandbox (`allow-scripts` only, `connect-src` blocked, CDN allowlist) and the server-side credential broker enforce this. Reports that break either boundary are treated as critical.

## Reporting a vulnerability

Email **security@snugprotocol.org**. Please include a reproduction. You will get an acknowledgment within **48 hours** and a resolution target within **90 days**; we ask for coordinated disclosure until a fix ships. No bounty program yet — credit given in release notes unless you prefer anonymity.

## Scope

All packages under `packages/`, the reference server, and the hosted Playground. The spec itself (design-level issues) is also in scope — file those against [`snugprotocol/spec`](https://github.com/snugprotocol/spec) or email the same address.

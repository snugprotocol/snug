# Lessons ledger (append-only)

Short, forward-looking rules learned the hard way. **The agent reads this when planning (Gate 2).** Newest at top, ≤10 lines each. Entry shape: `## YYYY-MM-DD — <one-line rule>` then **Context**, **What happened**, **Rule**.

---

## 2026-07-31 — Never trust availability by memory; verify names before proposing them
**Context:** TASK-20260731-bootstrap (naming rounds). **What happened:** ~20 candidate names (Whim, Carve, Knit, Gizmo, Nook, Yurt, Birdhouse, AXP…) all died on verification against GitHub orgs and web search — every "obviously free" name was taken by an active AI product. **Rule:** any public-facing name (package, command, protocol message) gets a GitHub/npm/web check *before* it is proposed, in the same session.

## 2026-07-31 — Port the hardening, not the bugs
**Context:** audits of the prior production systems this work extracts from. **What happened:** those systems contain a broken two-layer OAuth callback (`userLayer` never unwrapped) and an off-by-default strict-host-injection flag (prompt-injection exfiltration path). **Rule:** when extracting, carry forward the DB invariants + host-freeze from the hardened port and the PKCE/refresh/scrubbing from the original — and never reintroduce configurable security (strictness is not a flag).

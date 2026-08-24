# 0003 — v1 scope and hard security constraints inherited from prior production systems

- **Status:** accepted (amended by 0007 — per-app-file data posture replaced by the single portable user DB)
- **Date:** 2026-07-31
- **Task:** TASK-20260731-bootstrap

## Context
Snug extracts the "Native Apps" concept, proven twice in the author's prior production systems. Auditing those systems found: (a) no per-app DB actually existed (localStorage + tenant Postgres only); (b) "host-blind credentials" was access control, not cryptography; (c) a two-layer OAuth callback bug and an off-by-default host-injection strictness flag were live security holes.

## Decision
v1 scope = protocol bindings + iframe runner + SDK + **new-build per-app DB** (sql.js + OPFS, real `.sqlite` export) + knowledge base + adapters + Playground + minimal server. Auth broker is v1.1. Security constraints C1 (token boundary, strict host-binding always-on, response scrubbing) and C2 (sandbox `allow-scripts` only, `connect-src` blocked) are hard constraints from day one. Public claims never exceed implementation ("publisher-blind, encrypted at rest" — not "host-blind" — until a KeyProvider/KMS ships).

## Alternatives considered
Porting the prior auth implementation as-is (rejected: known bugs + weak-by-default injection); shipping without the per-app DB (rejected: it is the only hard differentiator vs Artifacts-class products).

## Consequences
~2 weeks of new DB work in v1; auth lands as a second launch moment. Honest claims constrain marketing copy (positioning notes are kept privately, C4).

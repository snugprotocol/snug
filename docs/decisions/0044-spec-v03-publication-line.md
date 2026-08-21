# 0044 — The spec v0.3 publication line: strict wire schemas publish strict; host contracts publish as prose

- **Status:** accepted (owner ask 2026-08-20: "go ahead with all those 3 steps and then push the changes to specs repo too")
- **Date:** 2026-08-20
- **Task:** TASK-20260820-spec-v03-whitepaper
- **Supersedes in part:** the AL-03 plan-D1 / AL-02 publication holds ("net frames and the
  auth surface stay OUT of `json-schemas.ts` SOURCES until Beta exit") and the AL-12 hold.
  Those holds were timing decisions, not shape decisions; the owner's commissioning of the
  v0.3 consolidated spec as the 1.0 release candidate is the timing change.

## Context

The consolidated `SPEC-v0.3-draft.md` (published to `snugprotocol/spec` as `cd011cc`)
specifies the whole protocol, but the machine-readable publication line had three open
questions its Appendix C recorded: whether the net and open-url frame pairs join the
JSON-Schema export set; how to carry the recorded `host-ready.json` drift; and whether the
Part III–V contract files (`connection-requirement`, `connection-url`, `chat-intent`,
`runtime-contract`, `sidecar-contract`) get JSON Schema exports at all.

Two facts constrain the answer. First, the four new frames are **strict** by design —
their fields become real network requests and browser navigations, so an unknown key is a
rejection (spec R2's stated exception) — and `z.toJSONSchema` of a `strictObject`
faithfully emits `additionalProperties: false`. Second, `z.toJSONSchema` **silently drops
`superRefine` rules**, so any export of a refined schema is weaker than the real contract:
the net-request export cannot express "no body on GET/HEAD" or "no credential-shaped
header", and a connection-requirement export could express neither the `lanHost` XOR nor
the per-kind coherence arms nor canonical-form comparison.

## Decision

1. **The net and open-url pairs are published** — `json-schemas.ts` SOURCES grows to 14
   files, regenerated and pushed byte-identical (carrying the `host-ready.json`
   `net`/`openUrl` drift with it). The strict pairs publish **strict**: their
   `additionalProperties: false` is the contract, and the R2 regression test now asserts
   the property in BOTH directions (tolerant files must never carry it; strict files
   always must).
2. **The refinement gap is stated where the artifact lives, not hidden.** Appendix C and
   the SOURCES comment both say it: the exported schema is the weaker envelope, the spec
   prose is normative for the refinements, and a validator that passes the schema has not
   yet validated the frame.
3. **The Part III–V contract files publish as normative prose plus reference contracts —
   no JSON Schema export is offered.** An export weaker than the contract would invite
   implementations that validate against the export and admit what the contract refuses
   (a public host beside a `lanHost`, an endpoints-bearing `linked_device` row). The
   spec's prose is normative; the reference implementation's exported TypeScript
   contracts are the machine-readable authority; in-package tests lock them.

## Consequences

- Four publication-line test pins were rewritten deliberately (`net-frames`,
  `auth-schema`, `render-directive`, `review-regressions`) — the old pins asserted the
  frames stay out; the new ones lock the 14-file set. Evidence at flip: protocol 345 ·
  auth 915 · db 391 · runner 119, all local (CI billing-blocked, ADR-0041).
- SPEC_SYNC's byte-identity invariant is TRUE again (spec repo `schemas/` ==
  `packages/protocol/schemas/` at `cd011cc`).
- Any future refined schema faces the same fork: publish the weaker envelope with the gap
  stated, or do not publish. Publishing without stating the gap is not an option this ADR
  leaves open.

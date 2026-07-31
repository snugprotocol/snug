# Spec changelog (append-only)

Every change pushed to `snugprotocol/spec`, newest first. Format: `## YYYY-MM-DD — spec vX.Y — TASK-id — <summary> — <spec commit SHA>`.

---

## 2026-07-31 — spec v0.0 — TASK-20260731-bootstrap — Initial spec repo scaffold (skeleton SPEC.md, empty schemas) — (SHA recorded at first push)

## 2026-07-31 — spec v0.1 DRAFT (staged, not pushed) — TASK-20260731-protocol-core
First protocol definition: 9 postMessage frames + chat envelope, rules R1–R6 (versioning,
additivity, terminal-frame guarantee, identity, open error codes, limits). Staged in
`packages/protocol/SPEC-DRAFT.md` + `schemas/*.json` (io:'input' — validators must accept
unknown fields). No push to snugprotocol/spec (needs explicit ask).

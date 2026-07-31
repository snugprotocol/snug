# Snug — Next Steps

Dated, ordered backlog. Append with a date; ✅ when shipped. Task files are the workspace; this is the queue. Full 6-week plan: `internal/01-extraction-launch-plan.md`.

---

## Now / next

- **2026-07-31 — Bootstrap** (this scaffold; ADR-0001..0003). ✅ scaffold committed; pending: GitHub org + repos + push, npm org registration, Cloudflare email verification click.
- ✅ 2026-07-31 — **Week 1–4 delivered in one umbrella (TASK-20260731-build-hub):** protocol v0.1 + runner (C2-gated) + knowledge store (ADR-0004) + sdk/db + server/adapters + playground/examples. Remaining from the original week-1 line: spec-repo push (needs explicit ask). Original items follow for traceability:
- **2026-07-31 — Week 1 (plan §5):** extract envelope protocol → `packages/protocol` · runner skeleton with C2 sandbox locked by tests · knowledge base port → `packages/knowledge` · draft SPEC.md v0.1 skeleton sync (first spec push — needs explicit ask).
- **Week 2:** `apps/server` (/invoke + artifact store) · `packages/adapters` (anthropic, openai, mock).
- **Week 3:** `packages/db` — sql.js + OPFS, `.sqlite` export/import · `useAppDB`.
- **Week 4:** Playground + examples (chess, flying-pig, habit-tracker).
- **Week 5:** polish, docs, demo videos, private beta (10–15 people).
- **Week 6:** launch (see `internal/LAUNCH_OPS.md` — landing page T-3, flip public T-2, Show HN).
- **v1.1 (+4 weeks):** `packages/auth` credential broker per `internal/03-audit-auth.md` build order.
- **2026-07-31 — Post-hub next:** eval harness for prompt changes (phase 2 — prompts are eval-addressable by path per ADR-0004) · demo videos + quickstart timing run (week 5) · spec v0.1 push to `snugprotocol/spec` (needs explicit ask) · auth broker v1.1 per `internal/03` build order.

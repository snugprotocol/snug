# TASK-20260803-app-context-chat: App-attached chat, durable pins, threads/docs UX, factory reset (child 3 of living-apps)

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: medium
- **Branch**: `feat/TASK-20260803-living-apps` (umbrella branch)
- **Packages touched**: `apps/playground`
- **Spec impact**: none
- **Related**: umbrella [TASK-20260803-living-apps](TASK-20260803-living-apps.md), children 1–2, TASK-20260803-versions-chat (F9 baseline)

## Spec (what & why)

Every chat page attaches to the loaded app: context assembler feeds the LLM the app's metadata, current HTML, schema registry JSON, knowledge docs, and recent thread history (both modes — direct as system/user block, subscription prepended into the wire message). Durable thread→app pin (thread row records the installed app id; sink initializes from it) kills the returning-builder duplicate. Per-app thread list + docs tab in a redesigned run rail (chat · versions · docs · inspector). Bootstrap (first build user+assistant messages) pinned immortal; artifact cards persist via message `meta`. Factory badge + always-available reset in VersionsPanel.

**Acceptance criteria** (umbrella AC4/AC5-part/AC6-part):
1. Reopen app in fresh session over same DB bytes → prior threads, messages, artifact cards render; thread list + new-thread works.
2. Enhance turn's outgoing request contains app HTML + schema + docs + history (mock adapter capture); assembler caps enforced with truncation markers (unit).
3. Builder thread resumed in a new session versions the SAME app (durable pin regression test).
4. Bootstrap = **the turn that produced the app's v1 artifact** (review F9 — not chronological message #1): that turn's user message + assistant reply are pinned via the sink's install signal; test includes pre-build chatter turns. Prune helper never removes pinned rows.
4b. Durable pin regression (review F10): remount/new-session over the same builder thread versions the SAME app — dedup for built apps is pin-based (`install_source` is NULL for them); cross-tab races precluded by the single-writer Web Lock posture.
5. Factory badge shown; reset-to-factory works after v1 would have been pruned unpinned.

**Out of scope**: hub tiles/SSO/design pass (child 4).

## Shared literals (from umbrella — verbatim)

Thread id forms `app:<id>` (primary per-app thread) / `thr-<uuid>` (builder + extra app threads, `app_id` set on the row) · message columns `pinned`, `meta` (JSON: `{artifact?: {appId, version, displayName}, wireText?}`) · doc slugs `vision|requirements|plan|lessons|memory|next-tasks`.

## Plan

`apps/playground/src/agent/appContext.ts` (assembler + caps) → `builder.ts`/`useBuilderChat.ts` (context injection, durable pin, bootstrap pinning, meta cards) → run rail redesign (`RunView.tsx` tabs, `ThreadsList`, `DocsPanel`) → `VersionsPanel` factory UX. Tests FIRST per AC.

## Decisions & surprises

—

## Session journal (append-only, newest last)

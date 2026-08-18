# 0035 — Starter authoring docs become the installed app's wiki seed

- **Status:** **accepted** (2026-08-17, owner-approved at Gate 2 and shipped with
  TASK-20260817-telepath). §1's "own module" requirement came from the Gate-2 review: the
  AC9 shape pin asserts every glob in `starterApps.ts` is app-html-shaped, so a second glob
  there would have failed the existing test — the new channel lives in `starterDocs.ts` with
  its own dedicated pin.
- **Date:** 2026-08-17
- **Task:** TASK-20260817-telepath

## Context

ADR-0031's AC9 gate requires every connected starter to ship an `authoring/` provenance bundle whose
`docs/` slugs are deliberately 1:1 with the `snug_app_docs` shape — "for a future ingestion phase
the owner will specify." The owner specified it (2026-08-17, Telepath interview): an installed
app's vision/requirements/plan/wiki docs AND the verbatim build prompt should live in the user's DB,
where the app-attached chat can compound on them. Today a validate-suite pin asserts the starter
shelf glob (`examples/*/app.html`) can never bundle `authoring/` content — provenance is dev-time
only.

## Decision

1. **Install-time ingestion, generic.** The explicit starter-install path (`installThisStarter` in
   RunView — the one that runs `installStarterConnections`/`installStarterRuntimeContract`; NOT the
   hub's open-only tiles) gains a sibling, `installStarterDocs`, living in its OWN module
   (`starterDocs.ts`) with its own `?raw` glob — `starterApps.ts` stays single-glob because the
   AC9 shape pin asserts every glob there is app-html-shaped. For any starter shipping
   `authoring/docs/*.md`, each file seeds a `snug_app_docs` row (slug = filename, title = first
   H1); `authoring/prompts/*.md` concatenate (in numbered order) into one `build-prompt` slug. All
   six connected starters benefit, not just Telepath.
2. **Seed absent slugs only, per slug.** An existing row is never overwritten — the wiki is the
   app's LIVING memory (ADR-0010) and a re-install must not clobber what the user's sessions have
   compounded. A partial prior state (some slugs present, whatever its cause) fills only the gaps.
3. **The shelf-glob pin stays, extended.** The `app.html` glob still cannot reach `authoring/`
   (that assertion is untouched); the NEW glob is separately pinned to match only
   `authoring/{docs,prompts}/*.md`. What changes is the doctrine sentence, not the guard: provenance
   now ships deliberately, through its own named channel, into the user's own file.

## Alternatives considered

- **Keep provenance dev-time only** — leaves installed connected apps with empty wikis their chat
  lane must rebuild from scratch; rejected by the owner ask.
- **LLM-generated docs at install** — burns tokens to approximate documents that already exist
  verbatim in the repo.
- **Ship docs inside `app.html`** — bloats the ≤5 MB artifact and conflates runtime code with
  memory; the DB is where app docs live (ADR-0010).

## Consequences

- Starter authors now know `authoring/docs` is user-facing seed content, not just provenance —
  the AC9 minimum (≥40 chars, real bodies) becomes a floor for genuinely useful docs.
- Playground bundle grows by the text of six starters' doc sets (KBs, not MBs).
- The `build-prompt` slug makes "what prompt built this app" a first-class, user-visible fact —
  aligned with the transparency posture the owner has held since the provenance requirement landed.

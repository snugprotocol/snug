# TASK-20260827-ownership-positioning: pivot public positioning from "agents to apps" to user ownership

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: low (owner call, Gate-1 interview 2026-08-27) — strictly copy, metadata and presentation; no logic, no protocol, no schema, no sandbox behaviour. Playground files touched are view/copy only.
- **Branch**: `feat/TASK-20260827-ownership-positioning`
- **Packages touched**: `apps/website`, `apps/playground` (copy only), `docs/product-vision.md`, root + org READMEs
- **Spec impact**: spec 1.0 **editorial correction, prepared not pushed** (ADR-0050 path; owner-approved 2026-08-27). §1's opening sentence only — prose, zero normative semantics. Master `docs/spec-drafts/SPEC-1.0.md` + publication `spec/SPEC.md` + generated website spec pages, with a `docs/spec-changelog.md` entry marked PREPARED. Push awaits an explicit ask.
- **Related**: **ADR-0061 (this task's decision)**, ADR-0048 (website derives from in-repo sources), ADR-0059 (Playground brain copy is a contract), ADR-0027, `docs/product-vision.md`, `apps/website/docs-sync.json`

## Spec (what & why)

The public story currently defines Snug against MCP ("MCP connects agents to tools. Snug connects agents to apps."). That framing makes MCP the foil, positions Snug as a competitor to complementary infrastructure, and leads with a mechanism rather than a consequence. The consequence is the stronger claim and the one the architecture actually earns: **the user is the durable owner of the application and its accumulated state; the host supplies the intelligence.**

This task re-leads every first-contact surface with ownership, portability, choice of runtime intelligence, and reduced SaaS custody — without weakening a single existing caveat, without claiming anything the implementation and spec do not support, and without redesigning the site.

**Acceptance criteria** (each becomes at least one test):
1. The homepage hero no longer leads with the MCP comparison; it leads with "Your software shouldn't need a landlord.", the ownership subheadline, and a concise technical explanation. The eyebrow and all three CTAs (download / playground / spec) survive.
2. The homepage carries the larger thesis section ("…Why are the applications they create still trapped?") between the demo and the detailed features, and an ownership framework (own it / move it / keep it private).
3. The homepage carries a "Not every app needs to become a service." section whose copy scopes the claim to an *application-specific* SaaS backend — never "no external service", never "no third party sees data".
4. The body/mind concept survives on both the homepage (WireDemo) and the architecture hero, as an architectural explanation sitting under the ownership framing.
5. The "why it's different" heading is no longer an absolute competitive claim; the three technical concepts (runtime relationship / one portable file / credentials outside generated code) survive and each maps to ownership.
6. Each of Fig 1–6 carries an explicit takeaway line; the existing ledes and captions (already precise) survive intact.
7. The architecture page's closing CTA no longer defines Snug through MCP; MIT/source/spec CTAs survive.
8. The architecture page's "What this doesn't do" section survives verbatim in substance — all six residuals still named.
9. Fully-local "nothing leaves the machine" language appears ONLY in Fig 5's local configuration; no other surface makes an unqualified no-data-leaves claim.
10. Metadata (title, description, OG/Twitter) on `/`, `/architecture/` and the Playground reflects the new positioning.
11. The Playground leads with "Build something that belongs to you.", carries "Apps that outlive the AI that created them." near the brain/model surface, and keeps the build affordance above any marketing copy. `export snug file` keeps its label (e2e + unit tests locate it by that name); ownership copy goes *around* it.
12. `docs/product-vision.md` positioning line matches the site, and `docs-sync.json` is re-hashed so `check-website-sync` stays green and meaningful.
13. Every previously-passing suite in the touched packages still passes; new tests pin the new positioning AND the retained caveats.

**Out of scope**:
- `docs/spec-drafts/SPEC-1.0.md` and the generated `apps/website/src/content/docs/docs/spec/**` (normative; spec-push rules; reported instead).
- `docs/whitepaper/src/paper.html` — its §11 already frames MCP as complementary related work, which is precisely the target framing. Verified, unchanged.
- Any protocol, wire, SDK, db, sandbox, adapter or Playground *behaviour*.
- Redesign, new component libraries, new visual language.
- Commits/pushes to `snugprotocol/spec`; any deploy or release.

## Plan

Order, tests FIRST per TDD.md:

1. **Tests first** — extend `apps/website/src/__tests__/` with a `positioning.test.ts` pinning AC1–AC10 (hero copy, thesis section, anti-SaaS scoping, retained body/mind, figure takeaways, no-MCP-foil in the closer, the six residuals, the Fig-5-only locality claim, metadata). Extend the Playground with a `hubPositioning.test.tsx` for AC11. Red first.
2. `docs/product-vision.md` — rewrite the Positioning line + one-liner around ownership; keep the three differentiators, anti-positioning, scope, roadmap and origin sections intact.
3. `apps/website/src/pages/index.astro` — hero rewrite + new thesis section + ownership framework; CTAs untouched; metadata.
4. `apps/website/src/components/Differentiators.astro` — heading + three-card copy remap to ownership.
5. New `apps/website/src/components/PersonalSoftware.astro` — the "Not every app needs to become a service." section, reusing existing section/eyebrow/type vocabulary (no new visual language).
6. `apps/website/src/components/ArchitectureFigures.astro` — add one `.fig-takeaway` line per figure; ledes/captions untouched.
7. `apps/website/src/pages/architecture.astro` — ownership kicker near the body/mind hero; closer CTA de-MCP'd; metadata. Limits section untouched.
8. `apps/playground/index.html` metadata; `src/views/HubView.tsx` hero; `src/views/BrainChip.tsx` / `DemoBrainCallout.tsx` vicinity for the outlive line; `src/views/SettingsView.tsx` export hint. **`export snug file` label unchanged** (pinned by `snugFileNaming.test.ts`, `desktopSettingsView.test.tsx`, `e2e/starters.spec.ts`).
9. Root `README.md`, `.github-org/profile/README.md`, `spec/README.md`, `apps/website/src/content/docs/docs/index.mdx`, `get-started/what-is-snug.md` — replace the slogan with the ownership one-liner; keep technical MCP references where they inform.
10. Re-hash `apps/website/docs-sync.json` for `product-vision.md`.
11. Verify: `pnpm --filter website test`, `pnpm --filter playground test`, `pnpm --filter website build`, `node scripts/check-website-sync.mjs`, then root `pnpm test`.

**Cross-package impact**: none by the dependency graph — website consumes playground source read-only (`@playground` alias) for `releaseChannel` constants only; no touched Playground file is in that path.

**Test plan**: source-asserted where the claim is an authoring fact (which copy exists), dist-asserted where the claim is about rendered output (metadata, no lost inline-tag spaces) — matching the seam the existing suites already draw.

## Decisions & surprises

- **Gate-1 interview (2026-08-27)** settled four things: update `product-vision.md` as the upstream source; extend to developer-facing entry points (READMEs, docs hub) but keep normative spec/whitepaper conservative; add figure takeaways *beside* existing prose rather than rewriting it; treat as Low risk, copy-only, tests still added.
- The existing Fig 4 caption already lands the exact "no intermediary that **accumulates**" point the brief asks for, and `architecturePage.test.ts` pins the word. The takeaway added there amplifies rather than replaces it.
- `spec/SPEC.md` and `docs/spec-drafts/SPEC-1.0.md` §1 open with "Snug connects agents to apps". That is normative overview prose, hash-gated, and behind an explicit-ask push rule. Left alone by design; surfaced in the report.
- The whitepaper needed no change — §11 "Related work" already presents MCP as complementary and inverse-directional, not as a foil.

## Session journal (append-only, newest last)

### 2026-08-27 — Jeetu — session
- Done: Gate 1 spec + Gate 2 plan written; repository inspected (Astro 7 + Starlight website, React/Vite Playground); all slogan occurrences located and classified.
- State: awaiting plan approval before any implementation code.
- Next step: create the branch, write the failing tests, then implement in the order above.
- Open questions: none blocking.

### 2026-08-27 — Jeetu — session (implementation, gates 3–5)
- Done, tests first: `positioning.test.ts` (47) + `ownershipCopy.test.ts` (15) written RED (32 failing), then implementation to green.
  - `docs/product-vision.md`: positioning + one-liner rewritten to ownership; MCP added to anti-positioning as complementary-not-competitor; a new **Claims discipline** block records what the architecture actually earns (application-specific backend only; hosted models see inference data; locality claim is local-config only; credentials ≠ app data).
  - Homepage: landlord hero + ownership subline + mechanism sentence; new thesis section ("…still trapped?") + own it / move it / keep it private; new `PersonalSoftware.astro`; Differentiators reheaded and remapped to ownership; closer no longer echoes the Playground hero.
  - Architecture: ownership kicker under body/mind; six `.fig-takeaway` lines (3 major: Figs 4/5/6); Fig 4/5/6 codas; closer de-MCP'd; limits section untouched.
  - Playground: hub hero + placeholder + empty state; "outlive the AI" beside the brain control (NOT the hero — that is where the claim is actionable); Settings export hint; metadata. `export snug file` label unchanged.
  - READMEs (root, org, spec) + docs hub index re-led on ownership; org banner alt-text left describing the STALE artwork with a comment (a screen-reader user must get what the image shows, not a corrected version).
- Surprises worth keeping:
  - **A real responsive bug shipped and was caught in the browser, not by the suite**: `minmax(24rem, 1fr)` in the new thesis grid overflowed 375px. Fixed with `min(24rem, 100%)` and pinned by a new "no unshrinkable grid track" test. Source assertions could not have found it; the standing no-horizontal-scroll tripwire earned its keep again.
  - `protectOfferRender.test.tsx` used the old hub hero as its "the hub rendered" marker. Marker updated, assertion meaning preserved — the test pins that the hub renders, not which words it uses.
  - The teaser video (recorded 2026-08-22) still shows the old Playground hero, so its caption now describes the footage generically instead of quoting copy the video does not contain.
  - The whitepaper needed NO change: §11 already frames MCP as complementary and inverse-directional.
- Verification: website 567/567 + tsc clean + astro build clean; playground 1709/1709 + tsc clean + vite build clean; playwright 80 passed / 1 pre-existing skip (incl. the 375px overflow spec and the export journey); root `pnpm test` exit 0 (25/25 tasks + all 9 gates); `check-website-sync` OK (24 pages / 40 hashes) after re-hashing; `check-public-scrub` OK. Visually walked / and /architecture/ at 1440px and 375px, plus the Playground hub and builder.
- State: implementation complete, all gates green, nothing committed (per the brief).
- Next step: owner review of the diff; then commit + PR if approved. Two items deliberately left for an owner call — see below.
- Open questions: none outstanding — both were answered by the owner on 2026-08-27 and executed (below).

### 2026-08-27 — Jeetu — session (owner decisions 1 & 2)
- **Decision 1 — spec §1 opener (PREPARED, NOT PUSHED).** Replaced the comparison-based opener with the architectural definition, in the master draft (`docs/spec-drafts/SPEC-1.0.md`), the publication (`spec/SPEC.md`), and the regenerated website spec pages.
  - **Terminology mapped to the spec's own, per the owner's conflict instruction:** "intelligence provider" → **LLM provider** (§7's three actors) and "compatible host" → **conforming host** (the term already used in §12.5/§12.9/§16 and Part VI). Meaning preserved exactly.
  - The previous sentence is kept verbatim behind "Concretely:", so the mechanical description is untouched.
  - A dated entry was added to the document's own **Revisions** block, matching the 2026-08-22 editorial-correction precedent. Version held at 1.0 per the header's own pre-launch editorial rule.
  - **Verified prose-only:** `packages/protocol/` clean, `spec/schemas/` clean, §1 byte-identical between master and publication (`diff` clean), `check-whitepaper` 104/104 against the edited fixture, `check-website-sync` OK.
  - `docs/spec-changelog.md` carries a **PREPARED, NOT PUSHED** entry awaiting the SHA and UTC time on push.
- **Decision 2 — org banner REGENERATED (an editable source existed).** The banner is not an opaque binary: `scripts/build-social-previews.mjs` renders it from SVG, reading brand colours out of `apps/playground/src/theme/tokens.css`. Headline is now the landlord line (52px display serif, ember italic on "landlord"); subline is the owner's preferred short form at 27px. Mark, wordmark, ember rules, two-repo columns and palette unchanged.
  - Both lines were **measured** against the 1088px usable width rather than trusted — SVG text neither wraps nor shrinks, and the runbook records a past overflow. Checked visually at the **800px** width the README actually renders it at.
  - Only the banner changed; both repo cards are byte-identical, so **no GitHub dashboard re-upload is needed**.
  - New PNG staged into `.github-org/profile/` (that repo's own commit+push is the owner's, per the runbook). Alt text now describes the new image — the earlier "describes stale artwork" comment is removed, since it no longer applies.

### 2026-08-27 — Jeetu — session (mobile nav + Gate 6 close)
- **Mobile nav (owner call, two changes).** Removed the visible "Menu" word from the `<summary>` and the Download CTA from the mobile sheet. Two follow-ons handled rather than left behind: (a) the block's comment cited a 2026-08-18 lesson that a bare glyph must not be nameless — the `aria-label="Menu"` already on the summary carries the accessible name, verified in-browser (`accessibleName: "Menu"`, `visibleText: ""`), and the comment now explains the current arrangement; (b) the control was a text-shaped pill with a height floor only, so icon-only it would have collapsed to ~30px wide — it is now square with `min-width` AND `min-height` at `var(--tap)`, measured **44×44**. Orphaned `.nav-sheet-cta` CSS deleted. `/download/` confirmed still reachable four ways on mobile (hero, try-it card, closer, footer) by querying the rendered page.
- **Six regression tests added** for the above, then **verified by reverting the markup** — 3 failed, then restored. A test that has never been seen to fail is a guess.
- **Gate 6.** ADR-0061 written (positioning is a durable decision that supersedes a documented line, so it earns an ADR, not just a journal entry). Five lessons recorded across two sections: the `minmax()` viewport overflow + comment-stripping trap, copy-as-a-test-marker, caption/alt-text honesty, "search for a generator before declaring an asset unmaintainable", and "move the hashed upstream source first". `docs/next-steps.md` gained a dated entry naming the three 🔑 items still owed; `docs/code-map.md` website row updated (positioning doctrine + 520→573 tests); ADR index updated. The three root AI files were untouched, so the sync rule is not engaged.
- **Advice given on three regeneration questions** (owner asked): website spec pages were already regenerated (only §1 + the manifest moved, `check-website-sync` OK); the **whitepaper needs nothing** — it never used the slogan, its source is unmodified since Aug 22, and its gate passes 104/104 against the edited spec; the **desktop DOES bundle the changed copy** (its Tauri shell compiles `@playground/App` — verified by building and grepping `dist/assets/*.js` for "belongs to you" and "outlive the AI"), but nothing is broken today and a release for copy alone is not worth the sign/notarize/`latest.json` blast radius — fold it into the queued v0.1.1→v0.1.2 walk.
- **Final verification:** website 573/573 + tsc + build clean · playground 1709/1709 + tsc + build clean · desktop 188/188 + tsc + build clean · playwright 80 passed / 1 pre-existing skip · root `pnpm test` exit 0 (25/25 tasks + all 9 gates) · `check-website-sync` OK · `check-public-scrub` OK · `check-whitepaper` 104/104. Walked `/` and `/architecture/` at 1440px and 375px and the Playground hub + a full build flow in a real browser.
- **Gate 6 gate run:** `gate-local --all` came back 5/6 with `desktop FAIL`. Cause was environmental, not code: the owner's installed `Snug.app` was running and held the single-instance lock, so the gate's debug shell exited instantly without writing results (the gate's own FATAL text names exactly this). Owner approved quitting the app; `--legs=desktop` then passed. **All six legs green across the two runs** — workspace · smoke · e2e · rust · release (`--all`) + desktop (re-run).
- **State:** committed on `feat/TASK-20260827-ownership-positioning`; PR next, then merge, then the two deploys (website + playground) — all at the owner's explicit ask this session.
- **Next step:** open the PR, merge it, then `node scripts/deploy-web.mjs all` → `--deploy` from clean `main`.
- **Open questions:** none. Three 🔑 items remain owed and are recorded in next-steps: push `snugprotocol/spec` (PREPARED entry awaiting SHA), commit+push `snugprotocol/.github` (banner), and the social re-scrape.

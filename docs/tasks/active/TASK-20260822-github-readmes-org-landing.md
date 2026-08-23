# TASK-20260822-github-readmes-org-landing: World-class READMEs for both repos + GitHub org landing page

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: **Low** (docs/presentation only — no package code, no protocol/runner/auth). Elevated care on two axes: the org `.github` repo goes **public pre-launch** (C4 discipline applies to its content) and the spec-repo push follows the explicit-ask release rule (granted this session, see journal).
- **Branch**: `feat/TASK-20260822-github-readmes-org-landing`
- **Packages touched**: root `README.md`, `docs/assets/readme/` (new), `apps/website/docs-sync.json` + two authored docs pages (sync walk), spec repo `README.md` (downstream, local clone), new `snugprotocol/.github` repo
- **Spec impact**: none — no normative change; spec repo README is presentation only (SPEC.md untouched)
- **Related**: ADR-0048 (public website), ADR-0051 (public spec presentation — engineering detail stays home), `docs/product-vision.md` (positioning + anti-positioning), `internal/LAUNCH_OPS.md` (org/registration state)

## Spec (what & why)

The GitHub org is where the website's GitHub link sends visitors (`site.ts → githubOrg`),
and the two repos are the first code surfaces anyone sees. Today: the org page has **no
profile README at all** (`snugprotocol/.github` does not exist — verified 404), and both
repo READMEs are accurate but modest front doors. Rewrite both READMEs as compelling,
visually-led entry points grounded in the website's messaging (hero: "MCP connects agents
to tools. Snug connects agents to apps."; the three differentiators from
`docs/product-vision.md`), and create the org profile README so a visitor landing on
github.com/snugprotocol immediately understands the project and is routed to the right
place.

**Interview outcomes (Gate 1, 2026-08-22):** `.github` org repo created **public now**;
push authorization for spec repo + org repo **granted this session** (snug README via
normal PR); visuals **yes** — screenshot(s) + optionally a GIF cut from the teaser
video, committed in-repo; audience priority **all three** — curious devs/HN first, then
embedders, then contributors.

**Acceptance criteria** (each becomes at least one check):
1. **Snug README**: opens with a hero visual (asset committed under `docs/assets/readme/`,
   total added assets ≤ ~8 MB) and a value proposition readable in one screen; has clearly
   findable paths for all three audiences — "try it in 10 minutes" quickstart (commands
   preserved and still accurate), an embedders' section pointing at the embed docs, and a
   contributors' section pointing at CONTRIBUTING + good-first-issues; every relative link
   resolves to a file that exists; every absolute link points at snugprotocol.org, the
   playground, or the org's repos.
2. **Spec README**: leads with Specification 1.0 status (version · date · NORMATIVE,
   ADR-0051 spirit — no task-id/process noise in the pitch), states what the protocol is
   in the website's language, and routes to SPEC.md / schemas / whitepaper /
   implementations and back to the reference repo + website. Prepared as a single local
   commit in `/Users/jeetu/SnugProtocol/spec`.
3. **Org profile**: `snugprotocol/.github` exists, public, with `profile/README.md`; the
   org page renders it; it presents the one-liner + differentiators, links website /
   playground / docs / spec / both repos, and states security contact. Content is
   C4-clean: nothing beyond what the public website already says.
4. **Sync gate**: `node scripts/check-website-sync.mjs` goes red after the README rewrite
   (proves the gate sees it), then green after the /sync-website walk — the two derived
   authored pages (`get-started/quickstart.mdx`, `get-started/implementors.md`) walked
   for spirit-staleness and the manifest re-hashed. `pnpm gate:local` green before PR.
5. **Positioning discipline**: no comparison to Artifacts/Bolt/v0, no capability claimed
   that isn't merged and demoed, no `internal/` content or codenames anywhere in the
   three documents (grep check).

**Out of scope**: website code changes (its GitHub link already targets the org page);
flipping `snug`/`spec` public; npm publishing; CONTRIBUTING/SECURITY rewrites; desktop
release pages; translations.

## Plan

Order of work (docs-first "tests" = the checks in the ACs, defined above before writing):

1. **Branch** `feat/TASK-20260822-github-readmes-org-landing` off `main` (snug repo). ✔
2. **Assets**: review `~/SnugProtocol/screenshots/{Coinbase,Dog,Gmail,Hue,Ledger,Rewind,Whatsapp}`
   and the two teaser `.mov` files; pick 1 hero (Playground/desktop build-and-run moment)
   + optionally 2–3 supporting shots; if GIF: cut ≤20 s, ≤8 MB via ffmpeg into
   `docs/assets/readme/`. Commit assets separately from prose for reviewability.
3. **Snug README rewrite** (`README.md`): hero (tagline + visual + badges + CTA row:
   website · playground · spec · download) → "what makes a Snug app different" (three
   differentiators, tightened) → 10-minute quickstart (existing commands verified) →
   "embed it in your product" → repo layout (kept, current table is good) → security
   posture paragraph (C1/C2 + threat-model link) → contributing + license footer.
4. **Sync walk** (/sync-website procedure): confirm gate red; walk `quickstart.mdx` and
   `implementors.md` against the new README (update if stale in spirit); re-hash
   `docs-sync.json`; gate green; `pnpm gate:local`.
5. **Spec repo README** (local clone `../spec`): rewrite per AC2; single commit
   `spec: README front-door refresh (from snug TASK-20260822-github-readmes-org-landing)`;
   push to `snugprotocol/spec` main (authorized this session) after Jeetu approves the text.
6. **Org landing**: `gh repo create snugprotocol/.github --public`; add
   `profile/README.md` (+ a one-line repo README pointing at profile/); push (authorized
   this session). Verify https://github.com/snugprotocol renders it logged-out
   (incognito-equivalent check via unauthenticated fetch).
7. **Record**: update `internal/LAUNCH_OPS.md` registration state (org `.github` repo
   exists, public); append spec-repo commit SHA to the task journal (no
   `docs/spec-changelog.md` entry — that log is for spec-version changes, and this is
   presentation-only with no version bump).
8. **PR** for the snug repo; AI review then human review per process.

Cross-package impact: none at code level. `docs-sync.json` manifest is the only
mechanical coupling (README → two authored website pages).

## Decisions & surprises

- `gh api repos/snugprotocol/.github` → 404: org profile repo does not exist; creating it
  is the whole "org landing page" fix. The website already links to the org page, so no
  website change is needed.
- **Pre-launch 404s accepted**: the public org profile will link to `snug`/`spec`, which
  are private until flip-public — logged-out visitors get 404s on those two links until
  launch. Mitigation: the profile leads with website/playground/docs links; repo links are
  presented as "opening at launch" until the flip (one-line edit at launch, tracked in
  LAUNCH_OPS).
- **First public artifact**: the `.github` repo is the org's first public repo pre-launch,
  a deliberate owner call (Gate 1 interview) consistent with LAUNCH_OPS "building in
  public posts use screenshots/video only" — profile content is restricted to what
  snugprotocol.org already publishes.
- Root README is a tracked source in `docs-sync.json` feeding `quickstart.mdx` and
  `implementors.md` — the rewrite must end with the /sync-website walk or `gate:local`
  stays red.

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (with Jeetu) — session
- Done: scoped repos/org state; Gate 1 interview complete (public `.github` now; pushes
  authorized this session; visuals yes; all three audiences). Grounding read:
  product-vision, landing page, ADR-0051, site.ts, docs-sync manifest, LAUNCH_OPS,
  lessons. Plan written.
- State: branch created; **stopped for plan approval** — no implementation yet.
- Next step: on approval → step 2 (assets) onward.
- Open questions: none blocking; hero-asset choice reviewed with owner at draft stage.

### 2026-08-22 (later) — Claude (with Jeetu) — session
- Done: plan approved; implemented all 8 steps.
  - Assets: `docs/assets/readme/` — teaser GIF (48 s → 640 px/8 fps, 6.0 MB), hub
    shot, 3 app-gallery shots (6.8 MB total, ≤8 MB budget).
  - Snug README rewritten (hero GIF + tagline + badges + CTA row → differentiators →
    app gallery → `pnpm dev` quickstart → embed section → security → layout table).
    Positioning grep clean; all relative links verified; externals restricted to
    snugprotocol.org/playground/shields/footer credits.
  - Sync walk: gate went red on README (proof), `quickstart.mdx` updated to the
    `pnpm dev` one-command path (was still teaching the pre-dev-runner two-process
    dance), `implementors.md` judged not stale; manifest re-hashed; gate green.
  - Spec repo README rewritten + pushed (authorized): commit `e39abbd`.
  - Org landing: created **public** `snugprotocol/.github` (local clone
    `../.github-org`, commit `90c43da`); verified logged-out render of
    github.com/snugprotocol (200, tagline present, raw image 200).
  - LAUNCH_OPS registration state updated (+ flip-day note to drop the profile's
    pre-launch paragraph).
  - `pnpm gate:local`: PASS workspace + smoke (e2e/rust/desktop/release deselected —
    no code touched).
- State: snug changes committed on `feat/TASK-20260822-github-readmes-org-landing`; PR open.
- Next step: AI review → human review → merge (gate:local evidence, CI billing-blocked).
- Open questions: none.

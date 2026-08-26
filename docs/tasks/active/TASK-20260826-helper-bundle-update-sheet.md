# TASK-20260826-helper-bundle-update-sheet: bundle the WhatsApp helper (size-gated) + fix the update sheet (clipping, stale "good to know")

- **Status**: draft
- **Owner**: Jeetu
- **Risk tier**: **High** (auto-escalated: touches the release/bundle config — `tauri.conf.json` bundle resources, `release-desktop.mjs`, release gate — and the desktop shell's helper spawn contract in `sidecar.rs`). The update-sheet half alone would be Low.
- **Branch**: `fix/TASK-20260826-helper-bundle-update-sheet`
- **Packages touched**: `apps/desktop` (tauri bundle config, `src-tauri/src/sidecar.rs`, release gate), `apps/whatsapp-sidecar` (install/pack script), `apps/playground` (`desktop/AppUpdateControls.tsx`, `desktop/desktop-releases.json`, `theme/app.css`), `scripts/release-desktop.mjs`, docs (ADR-0047 §12 amendment, threat-model delta residual, next-steps)
- **Spec impact**: none (protocol untouched)
- **Related**: ADR-0047 §12 (helper NOT distributed by the update channel), ADR-0032 (sidecar contract), TASK-20260816-whatsapp-twin (packaging declared out of scope there), `docs/security/threat-model-delta-desktop-update-channel.md` (helper-skew residual), `docs/next-steps.md` (spawner version-stamp check)

## Spec (what & why)

Two owner-reported issues, one task.

**Part 1 — helper bundling.** Today the Telepath WhatsApp helper is a dev-only install (`pnpm --filter whatsapp-sidecar install:helper` → `~/Snug/helpers/whatsapp-sidecar/`, spawned by `sidecar.rs` via the system `node`). A public DMG download has no helper. Measured cost of the installed tree: **62 MB on disk**, of which 26 MB is `@img/*` (sharp's libvips binary 17 MB + an 8.7 MB wasm build — an *optional* baileys dependency used only for media thumbnails), 9.2 MB baileys, 6.3 MB zod, 3.1 MB protobufjs; the helper's own `dist/` is 296 KB. Current DMG: 18 MB. **Caveat that decides the design:** bundling the JS does not remove the runtime dependency — the shell still spawns the *system* `node` and refuses below Node 20. Bundling the helper without a runtime therefore helps only users who already have Node ≥ 20; a full "works on any Mac" bundle means shipping a Node runtime (~40–50 MB uncompressed, ~20–25 MB compressed for a single arch; ×2 for universal) or a Node SEA.

**Part 2 — update sheet.** (a) The sheet opened from the header "update to vX" chip is clipped at the top-centre and cannot be scrolled to. Diagnosis (to be confirmed by screenshot at implementation): `.net-confirm-overlay` is a flex-centred fixed layer; `.release-notes-card` caps at `max-height: 80vh` but that is `content-box` height, so `80vh + 2 × padding + head + action-row` can exceed the window (Tauri min height 560 px) and a flex-centred overflowing child is clipped at the top with no scroll. (b) The sheet shows *"macOS only through 1.0 — the Windows WebView cannot yet hold our app-sandbox promise…"* because the sheet deliberately renders the fetched newer entries **plus the bundled full history** (Tesla-style, `AppUpdateControls.tsx:107–116`), and that line lives in **v0.1.0's** "Good to know" section, not v0.1.1's. It is the installed release's note, tagged "installed", not a note about the update. Whether history belongs in the sheet at all, and whether that v0.1.0 line should stay, is an owner call (see interview).

**Acceptance criteria** (each becomes at least one test) — to be finalised after the interview:
1. (P1) A bundled helper resource exists in the built `.app` at a fixed path, and `sidecar.rs` resolves the helper from the bundle (falling back to / preferring `~/Snug/helpers/` per the interview answer). Rust unit test on the resolution order.
2. (P1) The pack step produces a self-contained tree **without** `@img/*`/`sharp` (optional dep omitted) and the installed helper still starts and serves `/health` — script test in `apps/whatsapp-sidecar`.
3. (P1) Release gate asserts the helper resource is present in the bundle (MUST-APPEAR, like the updater endpoint).
4. (P1) `desktop-releases.json` v0.1.x "Good to know" line about the helper is corrected to the new truth; `check-website-sync`/DownloadView copy updated.
5. (P2a) Sheet card uses `box-sizing: border-box`, `max-height: calc(100vh - 2·padding)` and the overlay scrolls if the card still overflows — a jsdom test can only pin the class/CSS contract; the real check is a screenshot at 800×560 (min window) recorded in the journal.
6. (P2b) Sheet filtering per interview answer (e.g. only entries newer than the installed version, or history collapsed) — component test with `current = 0.1.0`, fetched `0.1.1`, asserting the v0.1.0 "Good to know" text is absent/collapsed.

**Out of scope**: shipping a Node runtime / SEA (unless the interview picks it — then it becomes its own follow-up task), updating the helper through the updater independently of the shell, Windows.

## Plan

_Pending interview answers — filled in before approval._

## Decisions & surprises

- The "Windows" line is not a bug in the trigger: it is the bundled v0.1.0 history rendered beneath the v0.1.1 entry by design (ADR-0047 §5 "Tesla-style" body).
- sharp/libvips is 42 % of the helper tree and is optional for baileys.

## Session journal (append-only, newest last)

### 2026-08-26 — Jeetu/Claude — session
- Done: investigation (sizes, spawn contract, sheet rendering path, CSS), task file, branch.
- State: awaiting interview answers, then plan → approval.
- Next step: interview.
- Open questions: see interview.

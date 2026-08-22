# TASK-20260822-whitepaper-mark-niche: paint the mark's niche ink on the whitepaper cover

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: low (one SVG + one CSS rule in docs/whitepaper)
- **Branch**: `fix/TASK-20260822-whitepaper-mark-niche`
- **Spec impact**: none

## Spec (what & why)

The snug mark's niche is a true knockout (Logo.tsx: "the page background shows
through"), which reads dark on the site's dark surfaces but WHITE on the whitepaper's
white cover — the one surface where the convention inverts. Owner ask: make it black
for consistency. Fix: on the PAPER only, split the single evenodd path into the ember
tile + an explicit ink-filled niche path (same geometry, no knockout). AC: cover
renders amber tile + black niche; checker green; PDF re-synced; page count unchanged
(33 — the shrink-to-fit tell).

## Session journal

### 2026-08-22 — Claude (Fable 5)
- Done: paper-only fix — the single evenodd path split into ember tile (currentColor)
  + explicit `.mark-niche` path filled `var(--ink)`; comment records why the paper
  departs from the canonical knockout. Rebuilt: 33 pages (no shrink-to-fit), checker
  104/104, cover crop reviewed (amber tile, black niche). Website re-synced (hash
  parity dist↔public); spec-clone staged PDF commit AMENDED to `dcda2c6` (still ONE
  unpushed commit covering both PDF refreshes — edition cover + niche; push on the
  owner's word).
- State: done pending merge.

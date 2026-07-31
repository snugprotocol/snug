<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM queries design, layout, theming, or polish topics; reachable only when the app-builder capability is enabled
blast-radius: the visual bar of every generated app — weakening this produces ugly, cramped, or single-theme apps
source: rewritten for Snug v0.1 from ancestor KBs (internal/05); Tailwind-specific guidance replaced with CSS custom properties (play CDN is not on the Snug allowlist)
-->

# Design Quality

## The Bar

A Snug app should look deliberately designed, not generated: coherent palette, comfortable
spacing, readable type, motion that explains state changes. Users judge the whole platform
by the first app they open. Styling is plain CSS in the single `<style>` block — the
Tailwind play CDN is NOT on the allowed CDN list ({{cdnAllowlist}}), so write real CSS with
custom properties.

## Theming: Follow the Host

The host delivers `theme` (`'light' | 'dark'`) in the ready signal and pushes `theme-change`
events; the template's hook surfaces it and the example `App` stamps it onto the root
element. Your ONLY job:

- Define every color twice via the `:root` / `:root[data-theme="dark"]` custom-property
  blocks in the template — then use `var(--bg)`, `var(--fg)`, `var(--card)`, `var(--accent)`,
  `var(--border)`, `var(--muted)` everywhere. Zero hard-coded colors in component CSS.
- Do NOT use `prefers-color-scheme` — the host's theme wins, not the OS.
- Check both themes mentally: contrast ≥ 4.5:1 for text in each.

## Layout: Adapt to the Container

The iframe ranges from a ~320px phone panel to a 900px+ desktop pane, starting around 400px
tall and expanding. Design desktop-first, then stack:

- Flexbox/grid with `gap`; never hardcode pixel widths for panels. Use `flex: 1` and
  `min-width: 0` so panels fill space instead of clustering.
- One `@media (min-width: 700px)` breakpoint is usually enough: side-by-side board +
  sidebar on wide, vertical stack on narrow.
- Board/grid cells: `aspect-ratio: 1` and fluid sizes (`clamp()` for piece glyphs, e.g.
  `font-size: clamp(1.2rem, 4vw, 3rem)`).
- Scale type and padding up on wide viewports; a desktop app must not look like a stretched
  phone app.

## Touch and Pointer

- Every interactive target at least 44×44px (the template's `button` rule enforces the
  floor — keep it).
- `:hover` affordances for mouse, `:active` feedback for touch; `cursor: pointer` on
  everything clickable.

## Motion

- Animate state changes so users see WHAT happened: piece slides, card flips, value
  count-ups. `transition: transform 0.2s ease, opacity 0.2s ease` covers most needs.
- While `isWaiting`, show a distinct thinking indicator (pulsing dots, subtle shimmer) and
  disable conflicting inputs. If streaming is used, render the growing `onStream` text in a
  commentary panel.
- Keep animations under ~300ms and never block input on decoration.

## Empty States and First Run

Never render a blank void:

- Before `isReady`: a small centered "Connecting…" note (template default).
- No data yet: say what the app does and present the one obvious first action ("Add your
  first workout", "Start game").
- Data tools: offer a "load sample data" button so exploration works instantly.
- After a reset or game over: a clear replay/start-over affordance with the outcome summary.

## Details That Read as Quality

- One accent color, used sparingly (primary action, active states) — everything else
  neutral from the theme variables.
- Consistent corner radius and spacing scale (pick 4/8/12/16px and stick to it).
- System font stack (already in the template) — web fonts are off-allowlist.
- Render the agent's `message` commentary with personality: a styled bubble or status line,
  not a raw string dumped in a corner.

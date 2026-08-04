# TASK-20260804 — logo mark variants (AC8, "ember glyph")

> ## ✅ DECIDED 2026-08-04 — the owner selected **Variant C, "The Ember Niche"**.
> Ship C in Phase D step 8 (`ui/Logo.tsx` + `public/favicon.svg`). A and B are kept below for the
> record only. Carry the two wire-up notes with it: the mark is set **~10% below the wordmark cap
> height** so it does not dominate the 2.5rem lockup, and `favicon.svg` **inlines `#e8873a`**
> (there is no CSS context in a favicon, so `currentColor` would render black).

Design scratch for AC8 of `TASK-20260804-hub-polish`. **Nothing here is wired into the app yet** —
this doc exists so the owner can pick one before Phase D step 8 ships the component + `favicon.svg`.

Constraints applied to all three (from the task brief and `apps/playground/src/theme/tokens.css`):

- `viewBox="0 0 32 32"`, hand-authored, no external refs, no `<filter>`, no gradients.
- Fill is `currentColor`, so the mark inherits `color` and themes automatically. Set
  `color: var(--ember)` at the call site; light theme swaps the token to `#c96f1e` for free.
- **Every hole is a true knockout** — a reversed subpath inside a single `fill-rule="evenodd"`
  path — so the page background shows through. No hole is faked with a `--bg`-colored shape,
  which means the marks survive on any surface (verified against `#171310`, `#faf6ef` and a
  mid-tone `#7a4a22`), not just the two theme backgrounds.
- No stroke thinner than 2 units anywhere; narrowest feature per variant is noted below.
- Abstract enclosure. No literal house, no chat bubble, no flame.

## How these were checked

Each mark was rasterized at a genuine 16×16 and magnified 12× with nearest-neighbour to see
which pixels actually survive, rather than shrinking a large render and guessing. The 16px
notes below are read off that pixel grid. Method and observations are recorded here because
the "weakness at 16px" claims are otherwise unfalsifiable.

---

## Variant A — "The Hearth Arch"

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="snug">
  <path
    fill="currentColor"
    fill-rule="evenodd"
    d="M16 2a12 12 0 0 1 12 12v10a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-9.5a2.5 2.5 0 0 0-5 0V24a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V14A12 12 0 0 1 16 2zm0 5.5a6.5 6.5 0 0 0-6.5 6.5 7.5 7.5 0 0 1 13 0A6.5 6.5 0 0 0 16 7.5z"
  />
</svg>
```

**Rationale.** A thick arch — a hearth mouth, or an alcove you can stand inside — with two legs
planted on the baseline and a crescent of air lifting off the inner curve. The enclosure is
open at the bottom, which reads as *shelter you walk into* rather than a sealed container, and
the inner crescent gives the mark a warm rising note without drawing a flame. Legs are 4 units
wide, the arch band is 5.5.

**Weakness at 16px.** The honest one. The crescent knockout collapses to a roughly one-pixel
smear on the pixel grid — present, but no longer legible as a shape, so at favicon size the
mark degrades to a plain arch. That arch silhouette is also the closest of the three to a
**horseshoe magnet**, which is a real misread risk at small sizes and in monochrome. The
open bottom means it does not sit on a filled tile, so it has less presence in a crowded
browser tab strip than B or C.

---

## Variant B — "The Nested Hold"

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="snug">
  <path
    fill="currentColor"
    fill-rule="evenodd"
    d="M11 2h10a9 9 0 0 1 9 9v10a9 9 0 0 1-9 9H11a9 9 0 0 1-9-9V11a9 9 0 0 1 9-9zm0 5A6 6 0 0 0 5 13v6a6 6 0 0 0 6 6h10a6 6 0 0 0 6-6v-6a6 6 0 0 0-6-6z"
  />
  <rect x="11.5" y="11.5" width="9" height="9" rx="3.5" fill="currentColor" />
</svg>
```

**Rationale.** A rounded-square ring holding a smaller rounded square at its centre — something
kept safe inside something soft. It is the most literal expression of the product idea (small
cosy apps you own, held by a hub) and the roundrect language matches `--radius-l`/`--radius-m`
directly, so it looks native beside the existing UI. The 5-unit ring and 9-unit core are the
chunkiest features of the three.

**Weakness at 16px.** It holds together — ring and core both stay distinct on the pixel grid —
but the core softens into a slightly mushy blob rather than a crisp square, and the two-unit
gap between ring and core is the first thing to fill in on a low-DPI display. The bigger
problem is not legibility but **meaning**: concentric-square-in-a-ring is very close to a
generic record button, a stop button, or a settings glyph, and it is the least ownable of the
three. It also carries the least warmth — it is geometric before it is cosy.

---

## Variant C — "The Ember Niche"

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="snug">
  <path
    fill="currentColor"
    fill-rule="evenodd"
    d="M10 2h12a8 8 0 0 1 8 8v12a8 8 0 0 1-8 8H10a8 8 0 0 1-8-8V10a8 8 0 0 1 8-8zm6 9a5 5 0 0 0-5 5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6a5 5 0 0 0-5-5z"
  />
</svg>
```

**Rationale.** A solid, generously rounded ember tile with an arched niche cut out of its lower
half — a lit alcove, a doorway with a warm room behind it, a keyhole into your own space. The
figure/ground is inverted relative to A and B: the *warmth is the mass* and the shelter is the
void, which is what makes it feel occupied rather than empty. The tile shape echoes `--radius-l`
and the app-icon idiom, so it looks correct the moment it lands in a tab or a dock.

**Weakness at 16px.** The niche survives cleanly, but it is a **small counter inside a large
mass**, so it is the variant most sensitive to a heavy-handed rasterizer: at 16px the arch
reads as a rounded slot and loses its arched top, flattening toward a plain rectangle. On a
light background the mark is also a large solid block of ember, which is noticeably louder
than the current text wordmark — beside `snug.` at 2.5rem it wants to be optically ~10% smaller
than the cap height or it dominates the lockup. Finally, being a filled tile, it is the least
distinguishable of the three if it ever has to render in a single flat color on an ember
background (the niche is then the only thing carrying the identity).

---

## Recommendation

**Ship Variant C — "The Ember Niche".**

Three reasons, in order of weight:

1. **It is the only one that measurably wins the 16px test.** On the pixel grid C is the
   cleanest of the three: solid mass, crisp counter, no ambiguous pixels. A's crescent
   disintegrates and B's centre goes mushy. AC8's whole point is a favicon that survives, and
   C is the one that does.
2. **It is the most ownable.** B is a record button; A is a horseshoe magnet. C's inverted
   figure/ground — warmth as mass, shelter as void — is specific to this product and does not
   collide with an existing UI glyph.
3. **It sits correctly in the existing system.** The filled roundrect matches `--radius-l`, the
   app-icon idiom, and the tile language already used across the hub, so it needs no new visual
   vocabulary.

The tradeoff being accepted: C is the loudest mark on the light theme, and its lockup with the
2.5rem wordmark will need the mark set slightly below cap height. That is a sizing decision at
wire-up time, not a redesign — and it is a cheaper problem than A's or B's, both of which are
legibility or meaning problems that no amount of sizing fixes.

Note for wire-up (Phase D step 8): the shipped component and `favicon.svg` should both use
`fill="currentColor"` with `color: var(--ember)`; the standalone `favicon.svg` needs the ember
hex inlined instead, since there is no CSS context in a favicon — and it should carry the dark
theme's `#e8873a`, which holds contrast against both light and dark browser chrome.

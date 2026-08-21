<!--
layer: knowledge-base
destination: served (whole or as ##-sections via searchKnowledge) by the {{appBuilderToolName}} tool when the host LLM picks libraries or debugs script loading; reachable only when the app-builder capability is enabled
blast-radius: which CDN URLs generated apps embed — a wrong URL here ships as a broken script tag in every app that uses that library
source: rewritten for Snug v0.1 from ancestor KBs; allowlist narrowed to the Snug CSP (no Tailwind play CDN, no Google Fonts)
-->

# CDN Compatibility

## The Allowlist Is Fixed

The iframe CSP permits scripts ONLY from: {{cdnAllowlist}} — plus `data:` URIs for inline
images/SVGs. This list is never widened at runtime. Notably NOT available: the Tailwind
play CDN and Google Fonts (style with plain CSS and the system font stack instead), and any
other origin. A script tag pointing anywhere else silently fails to load.

## UMD vs ESM: Why Libraries Break

There is no bundler and no Node in the iframe — `<script src>` tags need
browser-global (UMD/IIFE) builds that attach a variable to `window`.

- CommonJS builds (`module.exports = ...`) throw `ReferenceError: module is not defined`.
- Bare ESM builds (`export default ...`) fail in a classic script tag, and `import` maps
  are not part of the template — prefer UMD.

### Picking a URL

1. Look for `*.umd.js`, `*.umd.min.js`, `*.global.js`, `*.browser.js`, or a `dist/`
   `*.min.js` known to be UMD.
2. Confirm the global name the build exposes and use that in code (e.g. `window.Chess`).
3. When unsure, use an entry from the pinned table below rather than guessing.

### If no browser build exists — inline the logic

Do not fight module formats. Implement the logic in plain JavaScript inside the app (for
chess: board array, legal-move validation, FEN parse/serialize). A few hundred lines of
your own code beats a broken script tag.

### CommonJS shim (last resort)

```html
<script>var exports = {}, module = { exports: exports };</script>
<script src="https://cdn.jsdelivr.net/npm/some-lib@1/dist/index.js"></script>
<script>var SomeLib = module.exports;</script>
```

Fragile; prefer UMD builds or inlined logic.

## DATA: Pinned Known-Good CDN Builds

> DATA SECTION — treat as a lookup table, not prose. These exact URLs are verified
> browser-global builds on allowlisted origins. Copy them verbatim.

| Library | URL | Global |
|---|---|---|
| React 18 | `https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js` | `React` |
| ReactDOM 18 | `https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js` | `ReactDOM` |
| Babel standalone | `https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js` | `Babel` |
| chess.js (UMD era) | `https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js` | `Chess` |
| three.js | `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js` | `THREE` |
| d3 | `https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js` | `d3` |
| p5.js | `https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js` | `p5` |
| Chart.js | `https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js` | `Chart` |
| marked | `https://cdn.jsdelivr.net/npm/marked@9/marked.min.js` | `marked` |
| Tone.js | `https://unpkg.com/tone@14/build/Tone.js` | `Tone` |

### A CSP console error for a `.map` file is EXPECTED, not a bug

Loading any minified CDN bundle makes browser devtools try to fetch its sourcemap
sidecar (e.g. `babel.min.js.map`). The app sandbox sets `connect-src 'none'`, so that
fetch is refused and Chrome logs:

> Connecting to '…babel.min.js.map' violates the following Content Security Policy
> directive: "connect-src 'none'"

**This is C2 working correctly.** The SCRIPT itself loads fine (it is allowed by
`script-src` via the CDN allowlist) — only the sourcemap is blocked, and blocking it is
the point: `connect-src 'none'` is what stops an app exfiltrating data. The message
appears only with devtools open and has no effect on the running app.

Do **not** "fix" it by widening the CSP. `apps/playground/e2e/owner-report.spec.ts`
pins this distinction: it asserts the app still renders (proving the script loaded)
while treating the `.map` refusal as benign.

Notes:

- chess.js versions AFTER 0.10.x dropped the UMD build — pin 0.10.3 or inline the rules.
- Newer three.js versions are ESM-only; 0.160.0 is the pinned UMD line.
- Pin a major version in every URL (`@18`, `@7`) — never use an unversioned `latest` URL.

// viewer-wrapper.mjs — the SHAPE the artifact viewer stores and serves around a published
// kit page, as read back from the real artifact on 2026-09-06 (TASK-20260905 AC13; the
// journal has the full head). A test fixture, never production code: the two classic
// scripts stand in for the viewer's `__FRAME_PREAMBLE` (~0.6 KB) and frame runtime
// (~13 KB); their bodies are placeholders, their POSITION and kind are the measured facts —
// two `<script>` elements with no `type`, comment-fenced, ahead of the kit's own document,
// which the wrapper carries WHOLE (doctype and all) inside its `<body>`, then `</body></html>`.
export const VIEWER_WRAPPER_HEAD =
  '<!doctype html><html><head><!-- frame-runtime --><script>window.__FRAME_PREAMBLE={"v":1,"capabilities":{"artifact":"artifact.x.js","sample":"sample.x.js","downloads":"downloads.x.js"}}</script>' +
  '<script>(function(){"use strict";/* the viewer\'s frame runtime: defines window.claude with use(), the parent bridge, theme, scroll */})();</script><!-- /frame-runtime -->' +
  '<meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><style>:root{color-scheme:light}body{margin:0}</style></head><body>\n';
export const VIEWER_WRAPPER_TAIL = '\n</body></html>';

/** What `fetch(location.href)` and the Artifact tool's read hand back for a published kit page. */
export function wrapAsViewerPage(kitHtml) {
  return `${VIEWER_WRAPPER_HEAD}${kitHtml}${VIEWER_WRAPPER_TAIL}`;
}

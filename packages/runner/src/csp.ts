import { CDN_ALLOWLIST } from '@snugprotocol/protocol';

const CDN = CDN_ALLOWLIST.join(' ');

/**
 * The one and only CSP for Snug app iframes (hard constraint C2). A frozen module
 * constant: no API in this package parameterizes, widens, or rebuilds it — the
 * source-guard test enforces that at the text level.
 *
 * Shape rationale (ADR-0006):
 * - `'unsafe-inline' 'unsafe-eval'` + CDN allowlist: apps are single-file HTML using
 *   Babel-standalone for in-browser JSX — eval IS the execution model. The load-bearing
 *   controls are `connect-src 'none'` (no exfiltration), the opaque origin from
 *   `sandbox="allow-scripts"` (no storage/cookies), and `worker-src`/`child-src 'none'`
 *   (F3: a worker or nested browsing context must not become a fetch side-channel).
 * - No meta-ignored directives (`frame-ancestors`, `report-uri`, `report-to`, `sandbox`):
 *   this policy is delivered via <meta>, where those are silently dropped — including
 *   them would be false comfort.
 * - Meta delivery is defense-in-depth. Authoritative HTTP-header delivery is a
 *   server/playground obligation; srcdoc documents also inherit the EMBEDDER's CSP,
 *   which the embedding page must keep compatible (child-6 constraint).
 */
export const RUNNER_CSP: string =
  `default-src 'none'; ` +
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDN}; ` +
  `style-src 'unsafe-inline' ${CDN}; ` +
  `font-src ${CDN} data:; ` +
  `img-src data: blob:; ` +
  `connect-src 'none'; ` +
  `worker-src 'none'; ` +
  `child-src 'none'; ` +
  `frame-src 'none'; ` +
  `object-src 'none'; ` +
  `base-uri 'none'; ` +
  `form-action 'none'`;

/**
 * Injects RUNNER_CSP into untrusted app HTML as the FIRST element of <head>, via DOM
 * parsing — never string surgery (F1: `<script>` before `<head>`, uppercase tags,
 * comment decoys, and missing elements all defeat regex insertion, but the HTML parser
 * normalizes every one of them into a well-formed document with a real head).
 *
 * The output always starts with `<!doctype html>` (no quirks mode) and contains exactly
 * the parsed app content with the policy meta prepended.
 */
export function injectCsp(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // The text/html parser guarantees html/head/body exist regardless of input.
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', RUNNER_CSP);
  doc.head.insertBefore(meta, doc.head.firstChild);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

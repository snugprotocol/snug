// The 14 BROWSER_CSP_CHECKS, executed inside the SHELL's webview (AC7).
//
// This is the in-shell port of the e2e driver page
// (apps/playground/e2e/fixtures/csp.html): every check page is built by the
// runner's PRODUCTION dist (`injectCsp` runs on the webview's own text/html
// parser — the exact bytes the playground ships execute here), mounted in a
// fresh `sandbox="allow-scripts"` srcdoc iframe, and judged by the
// `snug-csp-verdict` postMessage. A MISSING verdict within `check.timeoutMs`
// is a FAIL with reason 'no-verdict' — the form-action check navigates away
// instead of reporting when the policy does not hold, so silence is failure
// by contract (AC7 "every verdict present").
//
// The gate window itself ships CSP-free (tauri.conf.json `"csp": null`), which
// is the weakest-embedder case the template's header demands.
//
// VERDICT COLLECTION may be tuned here if WKWebView delivers enforcement
// signals differently (docs/lessons.md 2026-07-31: assert
// securitypolicyviolation/absence-of-effect, never API return values) — but
// WHAT each check proves lives in packages/runner's shared template and is not
// this harness's to weaken.

import { BROWSER_CSP_CHECKS, CSP_VERDICT_MESSAGE_TYPE } from '@snugprotocol/runner';

import type { CheckResult } from './types.js';

/** The e2e pinned the suite at 14; a shrink would silently weaken the C2 gate. */
const EXPECTED_CHECK_COUNT = 14;

/** The one check needing real outbound network (jsdelivr positive control). */
const NETWORK_DEPENDENT_ID = 'allowlisted-cdn-and-eval-work';

interface TemplateCheck {
  id: string;
  html: string;
  timeoutMs: number;
}

function runOne(check: TemplateCheck): Promise<CheckResult> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    const networkDependent = check.id === NETWORK_DEPENDENT_ID;
    const finish = (result: CheckResult): void => {
      window.removeEventListener('message', onMessage);
      iframe.remove();
      resolve(networkDependent ? { ...result, networkDependent: true } : result);
    };
    const timer = setTimeout(() => {
      finish({ id: check.id, pass: false, detail: 'no-verdict' });
    }, check.timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      const d = event.data as { type?: string; id?: string; pass?: unknown; detail?: unknown } | null;
      if (d != null && d.type === CSP_VERDICT_MESSAGE_TYPE && d.id === check.id) {
        clearTimeout(timer);
        finish({ id: check.id, pass: d.pass === true, detail: String(d.detail ?? '') });
      }
    };
    window.addEventListener('message', onMessage);
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.width = '320px';
    iframe.style.height = '200px';
    iframe.srcdoc = check.html;
    document.body.appendChild(iframe);
  });
}

export async function runCspChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const ids = BROWSER_CSP_CHECKS.map((c) => c.id);
  const countOk = BROWSER_CSP_CHECKS.length === EXPECTED_CHECK_COUNT && new Set(ids).size === ids.length;
  results.push({
    id: 'csp-check-count',
    pass: countOk,
    detail: countOk
      ? `${EXPECTED_CHECK_COUNT} unique checks present`
      : `expected ${EXPECTED_CHECK_COUNT} unique checks, found ${ids.length} (${new Set(ids).size} unique)`,
  });
  // Sequential on purpose: one iframe at a time mirrors the e2e (one page per
  // check) and keeps verdict attribution trivial even though ids disambiguate.
  for (const check of BROWSER_CSP_CHECKS) {
    results.push(await runOne(check));
  }
  return results;
}

// legalShared.ts — the ONE vocabulary every legal artifact shares (ADR-0055 §4/§6;
// TASK-20260823-legal-terms-privacy-eula).
//
// Three artifacts say the same things about the same parties: /terms and /privacy
// (rendered by the playground — offline in the desktop app — and by the website through
// its `@playground` alias) and the DMG's EULA (`legal/eula.ts`, byte-copied to
// `apps/desktop/src-tauri/EULA.txt`). Anything two of them must agree on is exported
// from HERE, once, so a test can pin the copies to the constant instead of a reader
// noticing a drift (the one-contract-two-artifacts rule, lessons 2026-07-31).
//
// DEPENDENCY RULE (plan-review finding 1): the legal modules import nothing but this
// file and `config/site.ts` (pure string constants). The website build resolves
// `@playground/*` by alias only and carries no `@snugprotocol/*` dependency, so an
// import of `@snugprotocol/protocol` here would compile in the playground and fail in
// the website. Facts the documents must agree with elsewhere (the CDN allowlist) are
// RESTATED below and pinned equal by `legalContent.test.ts`.

import { REPO_URL, WEBSITE_URL } from '../config/site.js';

// ---------------------------------------------------------------- the parties (ADR-0055 §6)

/** Operates the website and the hosted Playground (owns the domain, pays for hosting). */
export const SITE_OPERATOR = 'TechVoyage LLC';
export const SITE_OPERATOR_DESCRIBED = 'TechVoyage LLC, a California limited liability company';
/** Signs and distributes the macOS application; holds the code copyright (LICENSE). */
export const APP_DISTRIBUTOR = 'Jeetu Maker';

/**
 * THE shared counterparty definition — verbatim in every artifact, so no disclaimer or
 * cap ever runs to the wrong party and there is no seam between the documents.
 */
export const WE_US_OUR_DEFINITION =
  '"We", "us" and "our" mean Jeetu Maker and TechVoyage LLC together, with their officers, members, employees and agents.';

export const LEGAL_CONTACT = 'hello@snugprotocol.org';
export const GOVERNING_LAW = 'the laws of the State of California';
/** Deliberately no county (owner call): a county adds nothing for a free product. */
export const VENUE = 'the state and federal courts located in the State of California';

/** The date every document carries; bump it with any wording change. */
export const LEGAL_UPDATED = '2026-08-23';

// ---------------------------------------------------------------- the byte-pinned sentences

/**
 * Threat-model R-30, disclosed rather than smoothed over (ADR-0055 §1). Identical in
 * /privacy and the EULA; `dmgEula.test.ts` compares whitespace-collapsed.
 */
export const UPDATE_CHECK_DISCLOSURE =
  'The desktop app checks github.com for a new version each time it starts. ' +
  'That request tells GitHub your IP address, the time, and the version you are running. ' +
  'You can turn it off in Settings.';

/** Paired with the disclosure wherever it appears (ADR-0047 §3: offered, never automatic). */
export const UPDATE_CHECK_PAIRING =
  'Nothing installs by itself: an update is offered and you choose. ' +
  'We do not receive that request; it goes to GitHub.';

// ---------------------------------------------------------------- restated facts, pinned by test

/**
 * The hosts an app iframe may load libraries from (C2's fixed allowlist). Restated as
 * bare hostnames; `legalContent.test.ts` pins them equal to `CDN_ALLOWLIST`.
 */
export const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'] as const;

/** Where the experimental in-browser model's weights come from (`?webllm=1` only). */
export const WEBLLM_WEIGHTS_HOST = 'huggingface.co';

/**
 * The MIT warranty disclaimer, verbatim from LICENSE (the test compares
 * whitespace-collapsed). Quoted, never paraphrased, wherever the documents disclaim.
 */
export const MIT_GRANT =
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and ' +
  'associated documentation files (the "Software"), to deal in the Software without restriction, ' +
  'including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, ' +
  'and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, ' +
  'subject to the following conditions: The above copyright notice and this permission notice shall be ' +
  'included in all copies or substantial portions of the Software.';

export const MIT_DISCLAIMER =
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT ' +
  'LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO ' +
  'EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER ' +
  'IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR ' +
  'THE USE OR OTHER DEALINGS IN THE SOFTWARE.';

// ---------------------------------------------------------------- URLs (single-homed)

export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';
/** The public, canonical copies — what the EULA and external surfaces point at. */
export const TERMS_URL = `${WEBSITE_URL}/terms/`;
export const PRIVACY_URL = `${WEBSITE_URL}/privacy/`;
export const THREAT_MODEL_URL = `${REPO_URL}/blob/main/docs/threat-model.md`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const SECURITY_POLICY_URL = `${REPO_URL}/blob/main/SECURITY.md`;

// ---------------------------------------------------------------- content model

/** A run of prose, or a link inside prose. Plain data: both renderers walk it. */
export type Run = string | { href: string; label: string };

export type Block =
  | { kind: 'p'; runs: Run[] }
  | { kind: 'list'; items: Run[][] }
  | { kind: 'table'; head: string[]; rows: Run[][][] }
  /** Text reproduced verbatim (the MIT disclaimer) — rendered as a quotation. */
  | { kind: 'quote'; text: string };

export interface LegalSection {
  id: string;
  heading: string;
  blocks: Block[];
}

export interface LegalDocument {
  slug: 'terms' | 'privacy';
  title: string;
  updated: string;
  intro: Run[];
  sections: LegalSection[];
}

/** Convenience constructors — the content modules read as prose, not as JSON. */
export const p = (...runs: Run[]): Block => ({ kind: 'p', runs });
export const list = (...items: Run[][]): Block => ({ kind: 'list', items });
export const quote = (text: string): Block => ({ kind: 'quote', text });
export const link = (href: string, label: string): Run => ({ href, label });

function runsText(runs: Run[]): string {
  return runs.map((r) => (typeof r === 'string' ? r : r.label)).join('');
}

/** Flatten a document to plain text — what the claim-discipline check reads. */
export function legalPlainText(doc: LegalDocument): string {
  const out: string[] = [doc.title, runsText(doc.intro)];
  for (const section of doc.sections) {
    out.push(section.heading);
    for (const block of section.blocks) {
      if (block.kind === 'p') out.push(runsText(block.runs));
      else if (block.kind === 'quote') out.push(block.text);
      else if (block.kind === 'list') out.push(...block.items.map(runsText));
      else out.push(block.head.join(' '), ...block.rows.map((row) => row.map(runsText).join(' ')));
    }
  }
  return out.join('\n');
}

/** Every link in a document (for the renderer tests and the external-link sweep). */
export function legalLinks(doc: LegalDocument): Array<{ href: string; label: string }> {
  const links: Array<{ href: string; label: string }> = [];
  const take = (runs: Run[]): void => {
    for (const r of runs) if (typeof r !== 'string') links.push(r);
  };
  take(doc.intro);
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'p') take(block.runs);
      else if (block.kind === 'list') block.items.forEach(take);
      else if (block.kind === 'table') block.rows.forEach((row) => row.forEach(take));
    }
  }
  return links;
}

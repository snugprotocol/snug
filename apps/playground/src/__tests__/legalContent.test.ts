// @vitest-environment node
// (reads LICENSE off disk; jsdom rewrites import.meta.url to an http URL, which
//  fileURLToPath refuses — the bundleTargets.test.ts precedent.)
// legalContent.test.ts — TASK-20260823-legal-terms-privacy-eula AC2 + AC3 (ADR-0055).
//
// The privacy statement and the terms are DATA (legal/*.ts), so their truthfulness
// claims can be pinned the way a config is pinned: every third party the threat model
// names appears in the table, the byte-pinned R-30 sentence is embedded verbatim, the
// custody claims stay inside ADR-0014 §5 / threat-model §7, and the parties are the
// ones ADR-0055 §6 names. Prose is not byte-pinned beyond what carries a legal or
// truthfulness load — a copy edit should not be a test edit unless it changed a claim.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CDN_ALLOWLIST } from '@snugprotocol/protocol';

import { findClaimViolations } from '../legal/claimDiscipline.js';
import { EULA_TEXT } from '../legal/eula.js';
import {
  APP_DISTRIBUTOR,
  CDN_HOSTS,
  GOVERNING_LAW,
  LEGAL_CONTACT,
  LEGAL_UPDATED,
  MIT_DISCLAIMER,
  MIT_GRANT,
  SECURITY_POLICY_URL,
  SITE_OPERATOR,
  THREAT_MODEL_URL,
  UPDATE_CHECK_DISCLOSURE,
  UPDATE_CHECK_PAIRING,
  VENUE,
  WEBLLM_WEIGHTS_HOST,
  WE_US_OUR_DEFINITION,
  legalLinks,
  legalPlainText,
} from '../legal/legalShared.js';
import { PRIVACY, THIRD_PARTIES } from '../legal/privacy.js';
import { TERMS } from '../legal/terms.js';

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const LICENSE = readFileSync(fileURLToPath(new URL('../../../../LICENSE', import.meta.url)), 'utf8');

const privacy = legalPlainText(PRIVACY);
const terms = legalPlainText(TERMS);

describe('the shared vocabulary agrees with the facts it restates', () => {
  it('CDN_HOSTS are exactly the protocol CDN allowlist (restated, never imported — website build)', () => {
    expect([...CDN_HOSTS].sort()).toEqual([...CDN_ALLOWLIST].map((u) => new URL(u).hostname).sort());
  });

  it('the MIT grant and disclaimer are LICENSE\'s own words', () => {
    expect(collapse(LICENSE)).toContain(collapse(MIT_GRANT));
    expect(collapse(LICENSE)).toContain(collapse(MIT_DISCLAIMER));
  });

  it('the parties are ADR-0055 §6\'s, and the definition joins them', () => {
    expect(SITE_OPERATOR).toBe('TechVoyage LLC');
    expect(APP_DISTRIBUTOR).toBe('Jeetu Maker');
    expect(WE_US_OUR_DEFINITION).toContain('Jeetu Maker and TechVoyage LLC together');
    expect(WE_US_OUR_DEFINITION).toMatch(/officers, members, employees and agents/);
  });

  it('venue names no county; contact is the single mailbox', () => {
    expect(VENUE).toBe('the state and federal courts located in the State of California');
    expect(VENUE).not.toMatch(/county/i);
    expect(LEGAL_CONTACT).toBe('hello@snugprotocol.org');
  });
});

describe('/privacy (AC2)', () => {
  it('leads with what does NOT happen, worded so it cannot outrun the code (review F4)', () => {
    const first = legalPlainText({ ...PRIVACY, sections: PRIVACY.sections.slice(0, 1) });
    expect(first).toMatch(/no server/i);
    expect(first).toMatch(/no account/i);
    expect(first).toMatch(/no analytics script/i);
    expect(first).toMatch(/set no cookie/i);
    // The honest bounds on those claims:
    expect(first).toMatch(/aggregate/i); // Cloudflare's zone counts
    expect(first).toMatch(/browser'?s storage|on this device/i); // the file + preferences live here
    expect(first).toMatch(/shared computer/i);
  });

  it('embeds the byte-pinned R-30 sentence and its pairing verbatim', () => {
    expect(privacy).toContain(UPDATE_CHECK_DISCLOSURE);
    expect(privacy).toContain(UPDATE_CHECK_PAIRING);
  });

  it('names every third party the threat model reaches — the fixed set, no more, no less', () => {
    expect(THIRD_PARTIES.map((t) => t.id).sort()).toEqual(
      ['cdn', 'cloudflare', 'github', 'huggingface', 'messaging', 'model-provider', 'sync-origin'].sort(),
    );
    const table = PRIVACY.sections.flatMap((s) => s.blocks).find((b) => b.kind === 'table');
    expect(table, 'the third-party table is rendered as a table block').toBeDefined();
    expect(table?.kind === 'table' ? table.rows.length : 0).toBe(THIRD_PARTIES.length);
  });

  it('the CDN row names all three hosts; the model row names the terms and the bill', () => {
    const cdn = THIRD_PARTIES.find((t) => t.id === 'cdn')!;
    for (const host of CDN_HOSTS) expect(cdn.name).toContain(host);
    const model = THIRD_PARTIES.find((t) => t.id === 'model-provider')!;
    expect(model.sees).toMatch(/prompts/i);
    expect(model.sees).toMatch(/app data/i);
    expect(model.sees).toMatch(/connected/i);
    expect(model.when).toMatch(/their own terms/i);
    expect(model.when).toMatch(/your (own )?bill/i);
    const hf = THIRD_PARTIES.find((t) => t.id === 'huggingface')!;
    expect(hf.name).toContain(WEBLLM_WEIGHTS_HOST);
    expect(hf.when).toMatch(/webllm=1|experimental/i);
  });

  it('the sync-origin row uses ADR-0014 §2\'s words and says "continuously", not "once" (review F3)', () => {
    const row = THIRD_PARTIES.find((t) => t.id === 'sync-origin')!;
    expect(row.sees).toMatch(/whole file/i);
    expect(row.sees).toMatch(/every saved key and token/i);
    expect(row.when).toMatch(/for as long as/i);
  });

  it('the messaging row carries R-9, R-10, R-32 AND the launch-time reconnect (review F3)', () => {
    const row = THIRD_PARTIES.find((t) => t.id === 'messaging')!;
    const text = `${row.sees} ${row.when}`;
    expect(text).toMatch(/other people/i); // R-9
    expect(text).toMatch(/terms/i); // R-10
    expect(text).toMatch(/devices? list|linked[ -]devices/i); // R-32
    expect(text).toMatch(/every launch|each time .* starts/i); // autostart_if_linked
    expect(text).toMatch(/until you unlink/i);
  });

  it('the GitHub row names the update check, the download and the feedback deep-link', () => {
    const row = THIRD_PARTIES.find((t) => t.id === 'github')!;
    const text = `${row.sees} ${row.when}`;
    expect(text).toMatch(/update/i);
    expect(text).toMatch(/download/i);
    expect(text).toMatch(/feedback|issue/i);
  });

  it('pseudonymisation is a reduction, never a guarantee, with the class statement', () => {
    expect(privacy).toMatch(/reduction, never a guarantee/i);
    expect(privacy).toMatch(/anti-default/i);
    expect(privacy).toMatch(/not anti-adversarial/i);
  });

  it('says plainly what it is NOT, and bounds the encryption claim (ADR-0043)', () => {
    expect(privacy).toMatch(/not zero-knowledge/i);
    expect(privacy).toMatch(/not end-to-end encrypted/i);
    expect(privacy).toMatch(/passphrase/i);
    expect(privacy).toMatch(/only you hold/i);
    expect(privacy).toMatch(/unrecoverable/i);
  });

  it('the rights section is honest about being empty', () => {
    expect(privacy).toMatch(/CCPA|California Consumer Privacy Act/);
    expect(privacy).toMatch(/GDPR/);
    expect(privacy).toMatch(/nothing (we )?hold|hold nothing/i);
    expect(privacy).toMatch(/not sold|sell or share|sold or shared/i);
    expect(privacy).toMatch(/export/i);
    expect(privacy).toMatch(/delete/i);
  });

  it('children: no age gate; a parent or guardian is asked to stay involved (Q5c)', () => {
    expect(privacy).toMatch(/parent or guardian/i);
    expect(privacy).not.toMatch(/\b(must|need to) be (at least )?(18|13|eighteen)\b/i);
  });

  it('links the threat model, and carries the parties and the date', () => {
    expect(legalLinks(PRIVACY).map((l) => l.href)).toContain(THREAT_MODEL_URL);
    expect(privacy).toContain(WE_US_OUR_DEFINITION);
    expect(privacy).toContain(SITE_OPERATOR);
    expect(PRIVACY.updated).toBe(LEGAL_UPDATED);
    expect(PRIVACY.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('/terms', () => {
  it('names the parties, then collapses to the shared definition', () => {
    expect(terms).toContain(WE_US_OUR_DEFINITION);
    expect(terms).toContain(SITE_OPERATOR);
    expect(terms).toContain(APP_DISTRIBUTOR);
    expect(terms).toMatch(/operated by TechVoyage LLC/);
    expect(terms).toMatch(/distributed by Jeetu Maker/);
  });

  it('MIT governs rights in the code and wins on conflict; the disclaimer is quoted verbatim', () => {
    expect(terms).toMatch(/MIT License/);
    expect(terms).toMatch(/conflict/i);
    expect(collapse(terms)).toContain(collapse(MIT_DISCLAIMER));
  });

  it('pre-1.0, backups are yours, nothing is recoverable by us', () => {
    expect(terms).toMatch(/pre-release|pre-1\.0/i);
    expect(terms).toMatch(/backup/i);
    expect(terms).toMatch(/recover/i);
  });

  it('security research is authorised by cross-link to SECURITY.md, not restated', () => {
    expect(legalLinks(TERMS).map((l) => l.href)).toContain(SECURITY_POLICY_URL);
    expect(terms).toMatch(/security research/i);
  });

  it('the indemnity is exactly four items and says so (Q5b)', () => {
    const section = TERMS.sections.find((s) => s.id === 'indemnity')!;
    const items = section.blocks.find((b) => b.kind === 'list');
    expect(items?.kind === 'list' ? items.items.length : 0).toBe(4);
    const text = legalPlainText({ ...TERMS, sections: [section] });
    expect(text).toMatch(/created, shared or published/i);
    expect(text).toMatch(/third-party service, account or credential/i);
    expect(text).toMatch(/breach of a third party'?s terms/i);
    expect(text).toMatch(/violation of law/i);
    expect(text).toMatch(/That is the whole of it/);
  });

  it('the cap carries the §1668 carve-out and the honest sentence (Q5a)', () => {
    expect(terms).toMatch(/maximum extent permitted by law/i);
    expect(terms).toMatch(/1668/);
    expect(terms).toMatch(/fraud/i);
    expect(terms).toMatch(/willful injury/i);
    expect(terms).toMatch(/gross negligence/i);
    expect(terms).toMatch(/violation of law/i);
    expect(terms).toMatch(/USD 50/);
    expect(terms).toMatch(/not a discount/i);
    expect(terms).toMatch(/one person|solo/i);
  });

  it('no warranty of security, pointing at the threat model\'s non-claims by name', () => {
    expect(terms).toMatch(/What this model does not claim/);
    expect(legalLinks(TERMS).map((l) => l.href)).toContain(THREAT_MODEL_URL);
  });

  it('children: no 18+ gate; parent or guardian (Q5c)', () => {
    expect(terms).toMatch(/parent or guardian/i);
    expect(terms).not.toMatch(/\b(must|need to) be (at least )?(18|eighteen)\b/i);
  });

  it('law, venue, contact — and no postal address anywhere', () => {
    expect(terms).toContain(GOVERNING_LAW);
    expect(terms).toContain(VENUE);
    expect(terms).toContain(LEGAL_CONTACT);
    for (const text of [terms, privacy, EULA_TEXT]) {
      expect(text).not.toMatch(/\b\d{2,5} [A-Z][a-z]+ (Street|St\.|Avenue|Ave\.?|Road|Rd\.?|Blvd|Drive|Dr\.)\b/);
      expect(text).not.toMatch(/\bCA \d{5}\b/);
      expect(text).not.toMatch(/P\.?O\.? Box/i);
    }
    expect(TERMS.updated).toBe(LEGAL_UPDATED);
  });
});

describe('claim discipline (AC3) — every published text, and the checker itself', () => {
  it.each([
    ['privacy', privacy],
    ['terms', terms],
    ['EULA', EULA_TEXT],
  ])('%s carries no forbidden or unbounded claim', (_name, text) => {
    expect(findClaimViolations(text)).toEqual([]);
  });

  it('the checker is not decorative: it trips on each planted violation', () => {
    expect(findClaimViolations('Snug is zero-knowledge by design.')).toHaveLength(1);
    expect(findClaimViolations('Your keys never leave your file.')).toHaveLength(1);
    expect(findClaimViolations('Everything is end-to-end encrypted.')).toHaveLength(1);
    expect(findClaimViolations('Your data is encrypted on our servers.')).toHaveLength(1);
    expect(findClaimViolations('Set a passphrase to protect the file.')).toHaveLength(1);
    expect(findClaimViolations('Names are pseudonymised before they reach the model.')).toHaveLength(1);
    expect(findClaimViolations('Snug is fully host-blind.')).toHaveLength(1);
    // …and stays quiet on the negated forms the documents use.
    expect(findClaimViolations('Snug is not zero-knowledge and not end-to-end encrypted.')).toEqual([]);
    expect(findClaimViolations('We do not claim your keys never leave your file.')).toEqual([]);
  });
});

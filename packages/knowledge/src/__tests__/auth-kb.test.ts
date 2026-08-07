// AL-05 (TASK-20260806-auth-kb): the auth/connected-API KB teaching.
//   - AC4a: the KB's example directive round-trips the REAL renderDirectiveSchema
//     (M49 — corrupt the example's kind → RED). Same cross-package pattern as the
//     inferrer few-shot contract test.
//   - AC3: the rendered teaching never teaches the LLM-excluded proposal keys, nor
//     the display-only echoes — 7 names checked in JSON-key/backtick context
//     (M51: teach headerTemplate → RED; M56: teach confidence → RED).
//   - AC10b: retrieval delivery — build-time auth queries return the 90-file's
//     emission teaching within searchKnowledge's top-5 (M58: demote the file's
//     auth headings → RED). Headings are retrieval-load-bearing (ADR-0004).
import { describe, expect, it } from 'vitest';
import { AUTH_KINDS, AUTH_WIZARD_DIRECTIVE_KIND, renderDirectiveSchema } from '@snugprotocol/protocol';

import { PROMPT_FILES } from '../generated/content.js';
import { getKnowledgeBase, searchKnowledge } from '../index.js';

const KB_AUTH_FILE = 'knowledge-base/app-authoring/90-auth-and-connected-apis.md';
const KB_OVERVIEW_FILE = 'knowledge-base/app-authoring/10-overview-and-contract.md';
const KB_DEFENSIVE_FILE = 'knowledge-base/app-authoring/70-defensive-coding.md';

function kbText(file: string): string {
  const section = getKnowledgeBase().find((doc) => doc.file === file);
  expect(section, `${file} missing from the knowledge base`).toBeDefined();
  return section!.text;
}

function authKbText(): string {
  return kbText(KB_AUTH_FILE);
}

/** Every fenced ```json block in the rendered teaching. */
function fencedJsonBlocks(text: string): string[] {
  return [...text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]!.trim());
}

describe('AC4a — the KB example directive round-trips the real schema (M49)', () => {
  it('contains at least one fenced json example, and EVERY one parses as a valid directive', () => {
    const blocks = fencedJsonBlocks(authKbText());
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      const parsed = renderDirectiveSchema.safeParse(JSON.parse(block));
      expect(parsed.success, `KB example is not a valid directive:\n${block}`).toBe(true);
      expect(parsed.success && parsed.data.kind).toBe(AUTH_WIZARD_DIRECTIVE_KIND);
    }
  });

  it('examples carry ONLY v/kind/proposal — no display-only echoes taught by example', () => {
    for (const block of fencedJsonBlocks(authKbText())) {
      expect(Object.keys(JSON.parse(block) as object).sort()).toEqual(['kind', 'proposal', 'v']);
    }
  });

  it('example kindHint values are real AUTH_KINDS members (open string in the schema — pinned here)', () => {
    for (const block of fencedJsonBlocks(authKbText())) {
      const proposal = (JSON.parse(block) as { proposal: { kindHint?: string } }).proposal;
      if (proposal.kindHint !== undefined) {
        expect(AUTH_KINDS).toContain(proposal.kindHint);
      }
    }
  });

  it('the SOURCE uses the {{authWizardDirectiveKind}} placeholder, never the retyped literal (M50)', () => {
    const raw = PROMPT_FILES['knowledge-base/app-authoring/90-auth-and-connected-apis.md'];
    expect(raw).toBeDefined();
    expect(raw).toMatch(/\{\{authWizardDirectiveKind\}\}/);
    // The rendered output would look identical with a retyped literal — only this
    // source-level check keeps the single-home guarantee (ADR-0004).
    expect(raw).not.toMatch(new RegExp(AUTH_WIZARD_DIRECTIVE_KIND));
  });
});

describe('AC3 — the teaching never names the LLM-excluded keys (M51/M56)', () => {
  // The five llmProposalSchema omissions + the two display-only echoes the host
  // recomputes (B2). Matched as taught keys — backticked or JSON-key context — so
  // ordinary prose stays free.
  const forbidden = [
    'fields',
    'userLayerFields',
    'headerTemplate',
    'registrationConsoleUrl',
    'registrationInstructions',
    'confidence',
    'provenance',
  ] as const;

  for (const key of forbidden) {
    it(`never teaches \`${key}\``, () => {
      const text = authKbText();
      expect(text).not.toMatch(new RegExp(`\`${key}\``));
      expect(text).not.toMatch(new RegExp(`"${key}"\\s*:`));
    });
  }
});

describe('AC10b — retrieval delivery: build-time auth queries reach the emission teaching (M58)', () => {
  // The KB reaches the builder ONLY as top-5 searchKnowledge sections; teaching
  // that cannot win retrieval does not exist. Queries: the app-builder tool
  // prompt's own auth examples + plausible build-time phrasings.
  const queries = [
    'connected api auth',
    'external api credentials',
    'external api',
    'api key',
    'auth',
    'useConnectedFetch',
    // Review C-minor: the tokenizer keeps 'oauth2_*' whole, so a bare 'oauth' query
    // scores ONLY if the prose contains the standalone word — pinned here.
    'oauth',
    // M66: the natural jargon a builder actually types. The searcher does not stem
    // and keeps 'api_key'/'bearer_token'/'oauth2_auth_code' whole, so the injected
    // {{authKinds}} literals score for NONE of these — only standalone prose does.
    // Measured before the fix: 'authentication' zero-scored the entire corpus (the
    // full-document fallback), and 'bearer token'/'access token'/'sign in with google'
    // ranked other files' sections first.
    'authentication',
    'bearer token',
    'access token',
    'sign in with google',
    'log in',
  ];

  for (const query of queries) {
    it(`"${query}" returns the 90-file's emission teaching in the top 3`, () => {
      // slice() matters: the zero-score fallback returns EVERY document, so an
      // unsliced find() would pass even when retrieval has effectively failed.
      // As authored the emission hit ranks FIRST for every query here; top-3
      // leaves margin for unrelated KB growth while still failing on demotion.
      const hits = searchKnowledge(query).slice(0, 3);
      const emissionHit = hits.find(
        (hit) => hit.file === KB_AUTH_FILE && hit.text.includes(AUTH_WIZARD_DIRECTIVE_KIND),
      );
      expect(
        emissionHit,
        `top-3 for "${query}": ${hits.map((h) => `${h.file}#${h.heading}`).join(' | ')}`,
      ).toBeDefined();
    });
  }
});

describe('AL-05 review C1 — the net-visibility teaching never overclaims the shipped inspector (M60)', () => {
  // The shipped frames timeline renders net frames with NO per-frame method/host/
  // status detail, and the mutating-call confirm supports a session-remember grant.
  // The teaching must claim no more than the host delivers (review finding C1).
  it('does not teach (method, host, status) detail or an always-visible / asks-every-time claim', () => {
    const text = authKbText();
    expect(text).not.toMatch(/method, host, status/);
    expect(text).not.toMatch(/always see|always asked|confirm each time|asked every time/i);
  });
});

describe('AL-05 review M63 — the emission doctrine branches on the multi-provider app', () => {
  // A first write needing TWO providers is jointly satisfiable under the old rules
  // only by bundling both providers' hosts under one providerName — which either
  // strands the second provider's host (registry hit discards declared hosts, its
  // calls die NET_HOST_BLOCKED with no connect CTA) or sends provider A's credential
  // to provider B's host (non-registry path). Emitting two directives does not help:
  // the reply scanner is first-valid-wins. So the teaching must say the shipped
  // truth — one connection per app at this version — and require telling the user.
  it('teaches the one-connection-per-app limit', () => {
    const text = authKbText();
    expect(text).toMatch(/one (connected )?provider|a single (connected )?provider|one connection/i);
    expect(text).toMatch(/this version/i);
  });

  it('forbids bundling two providers into one declaration, hosts included', () => {
    const text = authKbText();
    // The rule must reach BOTH halves: the name (declare one provider) and the
    // hosts (the stranded provider's hostnames stay out of declaredApiHosts).
    expect(text).toMatch(/never (bundle|combine)|do not (bundle|combine)|Never (bundle|combine)/);
    expect(text).toMatch(/declaredApiHosts[^.]*only the declared provider/i);
  });

  it('requires telling the user, and routes the stranded feature to the keyless fallbacks', () => {
    // Scoped to the multi-provider teaching: the keyless section already carries
    // "manual-entry or sample-data", so a whole-file match would pass without the
    // branch existing at all.
    const text = authKbText();
    const section = text
      .split(/\n(?=#{2,3} )/)
      .find((s) => /^#{2,3} [^\n]*two or more providers/i.test(s));
    expect(section, 'no multi-provider section in the rendered teaching').toBeDefined();
    expect(section).toMatch(/\btell the user\b|\bsay (so )?plainly\b/i);
    expect(section).toMatch(/manual[- ]entry/i);
    expect(section).toMatch(/sample[- ]data/i);
  });
});

describe('AL-05 review M62 — the no-hardcoding rule never rests on a false inertness claim', () => {
  // The host's credential-shaped-header strip is a header-NAME filter, not a
  // by-construction guarantee: a key written under an unmatched header name, or into
  // a URL query string, leaves the app intact. Teaching "it could not work anyway"
  // is both false AND a map of where the filter does not reach. The rule must stand
  // on WHY (the user's credential lives with the host; a written key is a leak),
  // never on a mechanical backstop.
  it('never claims a hardcoded credential is inert', () => {
    const text = authKbText();
    expect(text).not.toMatch(/(could|cannot|can't|would|will) ?n[o']t work/i);
    expect(text).not.toMatch(/even if you wrote one/i);
  });

  it('never maps the strip boundary by naming what is and is not inspected', () => {
    const text = authKbText();
    expect(text).not.toMatch(/strips?[^.]*headers/i);
    expect(text).not.toMatch(/credential-shaped/i);
  });

  it('still states the rule unconditionally', () => {
    const text = authKbText();
    expect(text).toMatch(/never write a key into the HTML/);
    expect(text).toMatch(/never add a key-entry\s+input to an app/);
    expect(text).toMatch(/never ask for a secret in chat/);
  });
});

describe('AL-05 review M64 — the older corpus does not contradict the connected-API teaching', () => {
  // The 90-file taught useConnectedFetch, but the higher-ranking overview still said
  // three hooks were the ONLY way to reach the host and listed no connected-API row in
  // its Section Map — so a builder querying "api" was authoritatively told the opposite
  // of the truth, and never learned the section exists. The CSP prohibition itself is
  // true and stays primary; only the missing host-mediated pointer is the defect.
  it('the overview does not claim three hooks are the only way to talk to the host', () => {
    const text = kbText(KB_OVERVIEW_FILE);
    expect(text).not.toMatch(/Three hooks[\s\S]{0,120}?ONLY way/i);
  });

  it("the overview's hook list names useConnectedFetch", () => {
    expect(kbText(KB_OVERVIEW_FILE)).toMatch(/`useConnectedFetch\(\)`/);
  });

  it('the Section Map has a row for the connected-API/auth section', () => {
    const text = kbText(KB_OVERVIEW_FILE);
    const sectionMap = text
      .split(/\n(?=#{2,3} )/)
      .find((s) => /^#{2,3} Section Map/i.test(s));
    expect(sectionMap, 'no Section Map section in the rendered overview').toBeDefined();
    expect(sectionMap).toMatch(/Connected APIs/i);
    expect(sectionMap).toMatch(/useConnectedFetch|auth/i);
  });

  for (const [label, file] of [
    ['overview', KB_OVERVIEW_FILE],
    ['defensive-coding', KB_DEFENSIVE_FILE],
  ] as const) {
    it(`the ${label} fetch prohibition stands AND points at the host-mediated path`, () => {
      const text = kbText(file);
      // The prohibition stays primary — never weaken C2 teaching.
      expect(text).toMatch(/`?fetch`?/);
      expect(text).toMatch(/CSP/);
      // ...and the builder is told where external calls DO go.
      expect(text).toMatch(/useConnectedFetch/);
    });
  }
});

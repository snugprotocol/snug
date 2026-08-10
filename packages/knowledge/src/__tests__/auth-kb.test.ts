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
import {
  CONNECTION_KINDS,
  CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
  renderDirectiveSchema,
} from '@snugprotocol/protocol';

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

// AC4a, RE-AIMED BY P2 (TASK-20260810-p2-pipeline), not relaxed.
//
// WHY THESE ASSERTIONS MOVED. As written they pinned the file to the v3 `auth_wizard`
// directive and its THREE-KEY `llmProposalSchema` proposal — the exact shape whose
// omissions (`fields`, `headerTemplate`, registration copy) produced the motivating
// defect: a Coinbase requirement collapsing to one generic field. P2 rewrites the
// doctrine onto the `connection_requirement` directive, so a test demanding every
// example be an `auth_wizard` directive with keys exactly {v,kind,proposal} is now
// asserting the defect. The two shapes cannot coexist in one file: AC4a iterates EVERY
// fenced block, so a single `connection_requirement` example fails it by construction.
//
// The GUARANTEE is preserved in full and is strictly stronger, because the successor
// schema validates far more: every example still round-trips the REAL
// `renderDirectiveSchema` (a corrupted example is still RED), still carries only the
// keys its schema declares (`strictObject` rejects extras), and its `kind` is still
// pinned to a protocol constant rather than a retyped literal.
//
// The v3 surface itself is NOT deleted here — `llmProposalSchema` and the `auth_wizard`
// directive keep shipping under the B1 cutover rule; their removal is P4's named exit
// item. What changed is only which directive this KB FILE teaches.
describe('AC4a — the KB example directive round-trips the real schema (M49; re-aimed at connection_requirement by P2)', () => {
  it('contains at least one fenced json example, and EVERY one parses as a valid directive', () => {
    const blocks = fencedJsonBlocks(authKbText());
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      const parsed = renderDirectiveSchema.safeParse(JSON.parse(block));
      expect(parsed.success, `KB example is not a valid directive:\n${block}`).toBe(true);
      expect(parsed.success && parsed.data.kind).toBe(CONNECTION_REQUIREMENT_DIRECTIVE_KIND);
    }
  });

  it('examples carry ONLY v/kind/requirement — no display-only echoes taught by example', () => {
    // `confidence` and `provenance` are display-only seats the HOST computes from the
    // channel it received the directive on. An example teaching either would invite the
    // builder to author its own trust grade — the same class of defect as the v3 echoes
    // this assertion originally guarded.
    for (const block of fencedJsonBlocks(authKbText())) {
      expect(Object.keys(JSON.parse(block) as object).sort()).toEqual(['kind', 'requirement', 'v']);
    }
  });

  it('example requirement kinds are real CONNECTION_KINDS members', () => {
    for (const block of fencedJsonBlocks(authKbText())) {
      const requirement = (JSON.parse(block) as { requirement: { kind?: string } }).requirement;
      expect(CONNECTION_KINDS).toContain(requirement.kind);
    }
  });

  it('the SOURCE uses the {{connectionRequirementDirectiveKind}} placeholder, never the retyped literal (M50)', () => {
    const raw = PROMPT_FILES['knowledge-base/app-authoring/90-auth-and-connected-apis.md'];
    expect(raw).toBeDefined();
    expect(raw).toMatch(/\{\{connectionRequirementDirectiveKind\}\}/);
    // The rendered output would look identical with a retyped literal — only this
    // source-level check keeps the single-home guarantee (ADR-0004).
    expect(raw).not.toMatch(new RegExp(CONNECTION_REQUIREMENT_DIRECTIVE_KIND));
  });
});

// AC3, NARROWED BY P2 (TASK-20260810-p2-pipeline) to the keys that are STILL excluded.
//
// WHAT THIS TEST WAS PROTECTING, and why three names left the list. The original seven
// were `llmProposalSchema`'s five omissions plus two display-only echoes, and the harm
// was credential MISDIRECTION: an LLM that authors the field LABEL dictates which secret
// the user pastes, and an LLM that authors the HEADER TEMPLATE dictates where that secret
// is sent. AL-04 answered that by making the seats INEXPRESSIBLE.
//
// P2 re-admits `fields`, `headerTemplate` and the registration copy deliberately, because
// inexpressibility was also what collapsed Coinbase's three credentials to one — and pays
// for them a different way (ADR-0017): bounds at parse, the registry-borrow ban, the
// template lint, and a strong field-by-field review that renders every re-admitted byte
// verbatim BEFORE any credential is collected. The defense moved from "the channel cannot
// say it" to "the user sees exactly what it says". Keeping these three names on a
// forbidden list would now forbid the doctrine from teaching the seats the pipeline
// requires — the untaught-seat problem P2-AC8 exists to close.
//
// WHAT DID NOT CHANGE: `userLayerFields` (registry-synthesized only — admission rejects it
// on every authoring channel) and the two display-only echoes the host computes for itself
// stay forbidden, and the C1 rules the original test backstopped are asserted directly by
// P2-AC8 ("never write a key into the HTML", "never ask for a secret in chat", and every
// header-template value being a `{{…}}` reference rather than a literal).
describe('AC3 — the teaching never names the still-excluded keys (M51/M56; narrowed by P2)', () => {
  const forbidden = ['userLayerFields', 'confidence', 'provenance'] as const;

  for (const key of forbidden) {
    it(`never teaches \`${key}\``, () => {
      const text = authKbText();
      expect(text).not.toMatch(new RegExp(`\`${key}\``));
      expect(text).not.toMatch(new RegExp(`"${key}"\\s*:`));
    });
  }

  it('the re-admitted seats are taught as SHAPE, never as a credential value (the C1 half that remains)', () => {
    // The reason the three names could leave the forbidden list at all: teaching WHERE a
    // credential goes must never become teaching WHAT it is. Every `fields` entry in every
    // worked example is a definition (key/label/type), and no example carries a `value`.
    for (const block of fencedJsonBlocks(authKbText())) {
      const requirement = (JSON.parse(block) as { requirement: { fields?: Array<Record<string, unknown>> } })
        .requirement;
      for (const field of requirement.fields ?? []) {
        expect(Object.keys(field)).not.toContain('value');
        expect(field['type']).toMatch(/^(text|secret|password|url)$/);
      }
    }
  });
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
      // P2 (TASK-20260810-p2-pipeline): the emission teaching now names the SUCCESSOR
      // directive kind. The retrieval guarantee is unchanged and undiluted — a top-3 hit
      // in the 90-file carrying the emission teaching — only the literal it is keyed on
      // moved, because the doctrine this test guards moved with it. Keyed on the
      // protocol constant, never a retyped string, so the next rename fails loudly here.
      const emissionHit = hits.find(
        (hit) => hit.file === KB_AUTH_FILE && hit.text.includes(CONNECTION_REQUIREMENT_DIRECTIVE_KIND),
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

// TASK-20260807-connection-reachability MINOR 15: the doctrine's "the directive is the
// ONLY way an app ever becomes connected" was falsified by this release. The install act
// is a third rung — an app can ship a `connection.json` that the user's install carries
// into the same strong review.
//
// This is deliberately MORE than a one-sentence fix. The surrounding emission rules are
// written for a builder LLM closing a reply with a directive, which a chat-less starter
// cannot produce; leaving the false absolute in place would teach the builder that a
// starter shipping a manifest is impossible, and leaving the rules unqualified would
// invite it to emit a directive for an app it did not write.
describe('the connected-app doctrine names every rung, not just the directive', () => {
  it('no longer claims the directive is the ONLY way an app becomes connected', () => {
    // The exact falsified absolute. Kept as a literal so the test fails if the sentence
    // is ever restored verbatim.
    expect(authKbText()).not.toContain('it is the only way an\napp ever becomes connected');
    expect(authKbText().replace(/\s+/g, ' ')).not.toContain('the only way an app ever becomes connected');
  });

  it('teaches the directive as the way an app YOU BUILD becomes connected', () => {
    // The claim is still true when scoped to the builder's own channel, which is the
    // only channel this file's reader has. Scoping it keeps the teaching directive
    // (emit one, exactly once) without asserting a falsehood about the whole product.
    const text = authKbText().replace(/\s+/g, ' ');
    expect(text).toMatch(/the only way an app you (build|write)[^.]*becomes connected/i);
  });

  it('names the install act as the other rung, without inviting the builder to use it', () => {
    const text = authKbText().replace(/\s+/g, ' ').toLowerCase();
    expect(text, 'the builder must know the rung exists').toContain('install');
    // …and must NOT be told to author manifests: `connection.json` is a first-party,
    // in-repo, PR-reviewed artifact. A builder emitting one would be exactly the
    // runtime app-proposes-a-connection channel the ratified posture forbids.
    expect(text, 'the builder must never be taught to author a manifest').not.toContain('connection.json');
  });

  it('still requires the directive for an app the builder itself writes', () => {
    // Guards the qualification against over-correction: if the emission rule softened
    // to "optional", a connected app the builder writes would ship unreachable — the
    // very bug this whole task exists to fix, reintroduced through the KB.
    const text = authKbText().replace(/\s+/g, ' ');
    expect(text).toMatch(/calls `useConnectedFetch`[^.]*exactly one directive/i);
  });
});

// ---------------------------------------------------------------------------
// TASK-20260810-p2-pipeline (Dynamic Auth v2, P2) AC8 — KB DOCTRINE.
//
// The pipeline P2 builds is only as good as what the builder emits into it. The v3
// doctrine above teaches a THREE-KEY proposal (`providerName`/`kindHint`/
// `declaredApiHosts`) — which is exactly the shape that produced the motivating defect:
// a Coinbase requirement collapsing to one generic field, because the doctrine had no
// vocabulary for "this provider needs three values". So P2 rewrites the doctrine to
// teach the FULL requirement.
//
// Three claims, each with a named failure it exists to prevent:
//   1. BUILD-TIME EMISSION — the requirement is declared while the app is being built,
//      and lands before first run. A doctrine that says "the wizard will sort it out"
//      reintroduces the run-time inference surface Q5 removed.
//   2. THE SKIP-RULES — re-emit only when the change touches the auth surface. Without
//      them, every UI-only edit re-emits, and a re-emitted requirement against an
//      APPROVED row stages a re-approval prompt the user did nothing to earn.
//   3. THE COMPLETENESS BAR — "declare every field the provider requires; a key without
//      its secret is a defect." This is the sentence that fixes the Coinbase case.
//
// Written RED-FIRST at Gate 3: the P2 doctrine is not in the file yet.
//
// PROMPT AUTHORING NOTE (standing house reference, `prompts/README.md`): the rewrite is
// authored against Anthropic's prompt-engineering best practices — the claims below are
// deliberately about CONTENT and STRUCTURE (an explicit rule list, a worked multi-field
// example, an explicit negative case) rather than phrasing, so the doctrine can be
// re-worded for the model without the tests fighting the author.
describe('P2-AC8 — the KB doctrine teaches build-time emission, the skip-rules, and the completeness bar', () => {
  it('teaches BUILD-TIME emission: the requirement is declared as the app is built, before first run', () => {
    const text = authKbText().replace(/\s+/g, ' ');
    expect(text).toMatch(/before (the app|it) (is )?(first )?runs?|before first run|as you build/i);
    // ...and never defers the declaration to the wizard/run surface (Q5: no run-time
    // inference exists to catch it).
    expect(text).not.toMatch(/the wizard will (work it out|figure|infer)/i);
  });

  it('teaches the COMPLETENESS BAR — every field the provider requires, named as a defect when partial', () => {
    const text = authKbText().replace(/\s+/g, ' ');
    // The bar itself...
    expect(text).toMatch(/every (credential )?(field|value) (the|that) provider requires/i);
    // ...and the concrete consequence sentence that makes it stick.
    expect(text).toMatch(/a key without its secret is a defect/i);
  });

  it('teaches the multi-field shape by WORKED EXAMPLE, not by assertion (the Coinbase case)', () => {
    const blocks = fencedJsonBlocks(authKbText());
    const multiField = blocks
      .map((block) => JSON.parse(block) as { requirement?: { fields?: unknown[] } })
      .find((directive) => (directive.requirement?.fields?.length ?? 0) >= 3);
    expect(
      multiField,
      'no worked example declares a 3+ field requirement — the defect the phase exists to fix is untaught',
    ).toBeDefined();
  });

  it('teaches the SKIP-RULES: re-emit only when the edit touches the auth surface', () => {
    const text = authKbText().replace(/\s+/g, ' ');
    // UI-only edits skip...
    expect(text).toMatch(/ui[- ]only|only the (look|layout|styling)|did not change (the )?auth/i);
    // ...an already-valid requirement with no auth change asked skips...
    expect(text).toMatch(/already declar|a valid (connection )?requirement (already )?exists/i);
    // ...and re-emitting an unchanged requirement is explicitly a no-op, not a hedge.
    expect(text).toMatch(/re-?emit/i);
  });

  it('the skip-rules live in their own retrievable section (headings are retrieval-load-bearing, ADR-0004)', () => {
    const section = authKbText()
      .split(/\n(?=#{2,3} )/)
      .find((s) => /^#{2,3} [^\n]*(edit|chang)/i.test(s));
    expect(section, 'no edit/skip-rules section in the rendered teaching').toBeDefined();
  });

  it('the doctrine STILL forbids the builder from writing a credential anywhere (C1 unchanged by P2)', () => {
    // The re-admitted seats (`fields`, `headerTemplate`, registration copy) describe
    // WHERE a credential goes; they must never invite the builder to supply one. This is
    // the guard that the richer channel did not soften the oldest rule in the file.
    const text = authKbText();
    expect(text).toMatch(/never write a key into the HTML/);
    expect(text).toMatch(/never ask for a secret in chat/);
  });

  it('the signed-header teaching is shown by TEMPLATE reference, never by a credential value', () => {
    // NOT a vacuous loop: at least one example must carry a headerTemplate, because the
    // re-admitted `request.headerTemplate` seat is the one an LLM has never been taught
    // to author before — an untaught seat is an unusable one. THEN every value in every
    // such template must be a `{{…}}` reference, so no example ever models a literal.
    const templates = fencedJsonBlocks(authKbText())
      .map(
        (block) =>
          (JSON.parse(block) as { requirement?: { request?: { headerTemplate?: Record<string, string> } } })
            .requirement?.request?.headerTemplate,
      )
      .filter((template): template is Record<string, string> => template !== undefined);

    expect(
      templates.length,
      'no worked example teaches request.headerTemplate — the newly re-admitted seat is untaught',
    ).toBeGreaterThanOrEqual(1);

    for (const template of templates) {
      for (const value of Object.values(template)) {
        expect(value, `header template value is not a {{…}} reference: ${value}`).toMatch(/\{\{.+\}\}/);
      }
    }
  });
});

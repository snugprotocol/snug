// TASK-20260818-ledger-starter Phase A (ADR-0038): the `simplefin` registry entry and the
// `token-claim` pairing variant.
//
// WHY A THIRD PAIRING VARIANT RATHER THAN A REUSE. `exchange` is Hue's shape: one POST
// whose body is PINNED REGISTRY DATA and whose response is walked by `secretPath`.
// `device-link` is WhatsApp's: three beats and a poll. A claim-once provider is neither —
// the user pastes a ONE-TIME token that IS the request target (a base64-encoded claim
// URL), the response body IS the minted credential (an access URL carrying basic-auth
// userinfo), and the mint fills TWO fields, not one. Overloading `secretPath` to
// sometimes mean "parse the body as a URL and split its userinfo" would make one field
// mean two things — the exact reason `device-link` was discriminated rather than folded
// into `exchange` (ADR-0032), repeated here.
//
// WHAT THE SEAT DELIBERATELY CANNOT EXPRESS, inheriting the family discipline: no HOST
// (the pasted token's decoded URL is checked AGAINST the frozen ceiling, never trusted —
// ADR-0023's binding order: approve → freeze → claim), no HEADER TEMPLATE (the claim is
// uncredentialed by definition), no arbitrary response handling (the body is parsed by
// the URL API and refused unless https + on-ceiling + default port + the entry's exact
// `accessPath` — fresh-context review Blocker 3 made the base path a checked invariant).
//
// NEGATIVE TESTS ARE THE MAJORITY (High tier): what proves the entry is pinned is what
// the guards REFUSE once it exists.

import { describe, expect, it } from 'vitest';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

import { admitConnectionRequirement } from '../requirement-admission.js';
import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
  resolveRegistryEntryByName,
} from '../well-known-providers.js';

const entry = WELL_KNOWN_PROVIDERS_REGISTRY['simplefin'];

describe('the simplefin entry', () => {
  it('exists and declares the basic_auth kind', () => {
    // basic_auth, deliberately: the minted access URL carries userinfo credentials, and
    // the kind DEFAULT produces the `Authorization: Basic` header with no `request` seat
    // at all — the executor, scrub, custody and revoke paths apply unmodified (ADR-0038 D3).
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('basic_auth');
  });

  it('is keyed so BOTH resolution rungs reach it (the borrow-ban regression)', () => {
    // The whatsapp-personal lesson, restated per new entry: both rungs key on the
    // NORMALIZED name, so a key that `normalizeProviderKey('SimpleFIN')` does not
    // produce is an entry the borrow ban never defends.
    const normalized = 'SimpleFIN'.toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(Object.hasOwn(WELL_KNOWN_PROVIDERS_REGISTRY, normalized)).toBe(true);
    expect(resolveRegistryEntryByName('SimpleFIN')?.entry).toBe(entry);
    expect(resolveRegistryEntryByName('SimpleFIN Bridge')?.entry).toBe(entry);
  });

  it('pins EXACTLY ONE host — the singleton ceiling is load-bearing, not a style choice', () => {
    // Two facts require it (fresh-context review Blocker 2): symbolic
    // `snug-connection://` resolution refuses any row whose ceiling is not exactly one
    // host (NET_AMBIGUOUS_CONNECTION), and the declared test probe fires at
    // `allowedHosts[0]` — under a sorted two-host ceiling both would break a REAL
    // production claim (beta-bridge sorts before bridge).
    expect(entry?.apiHosts).toEqual(['beta-bridge.simplefin.org']);
    expect(entry?.lanHost).toBeUndefined();
  });

  it('declares exactly the basic_auth field pair, in injection order', () => {
    // ORDER is the contract: the basic_auth kind default reads fields[0] as the
    // username and fields[1] as the password. Exact and ordered, never `length > 0`
    // (the static-kind mutation lesson).
    expect(entry?.fields?.map((field) => field.key)).toEqual(['username', 'password']);
    expect(entry?.fields?.[0]?.type).toBe('text');
    expect(entry?.fields?.[1]?.type).toBe('secret');
  });

  it('tells the user the fields are minted, not looked up', () => {
    // The founding wizard defect inverted: these boxes are FILLED BY the claim, so a
    // user staring at them must learn there is nothing to go find. The copy is the
    // difference between a working flow and a support thread.
    for (const field of entry?.fields ?? []) {
      expect(field.label.length, `${field.key} must be named for the user`).toBeGreaterThan(0);
      expect(field.description ?? '').toMatch(/claim|created|filled/i);
    }
  });

  it('declares field DEFINITIONS only — never a credential VALUE (C1)', () => {
    for (const field of entry?.fields ?? []) {
      expect(field).not.toHaveProperty('value');
    }
  });

  it('carries NO request seat — the basic_auth kind default is the injection', () => {
    // A request seat would SUPPRESS the kind default (ADR-0022: either template
    // suppresses it), so its absence here is a behavior, not an omission.
    expect(entry?.request).toBeUndefined();
  });

  it('is browser-callable, verified — never assumed', () => {
    // Live probes 2026-08-18: OPTIONS and GET /simplefin/accounts on the bridge echo an
    // arbitrary Origin with `access-control-allow-headers: authorization` and
    // credentials allowed; the claim POST returns CORS headers and is preflight-free
    // (no custom headers). The tri-state seat is `true` only because of that probe.
    expect(entry?.browserCallable).toBe(true);
  });

  it('carries a registration WALKTHROUGH with a console URL and layman steps', () => {
    const registration = entry?.registration;
    expect(registration?.consoleUrl).toBe('https://beta-bridge.simplefin.org/');
    expect((registration?.instructions ?? []).length).toBeGreaterThan(2);
    // The walkthrough must name the thing the user goes to get — the setup token.
    expect((registration?.instructions ?? []).join(' ')).toMatch(/setup token/i);
  });

  it('declares NO OAuth endpoints and NO scopes — basic auth is neither', () => {
    expect(entry, 'simplefin must exist before its posture can be asserted').toBeDefined();
    expect(entry?.endpoints).toBeUndefined();
    expect(entry?.scopes).toBeUndefined();
  });

  it('pins the connection test probe at the /simplefin base path', () => {
    // The bridge serves under `/simplefin` — a probe at `/accounts` 404s and reports a
    // working connection as broken (review Blocker 3). `balances-only=1` keeps the
    // probe cheap; the bridge answers 403 to bad credentials, which is what makes it a
    // GOOD probe (the CoinGecko anti-lesson: a host that answers 200 keyless launders
    // broken connections).
    expect(entry?.testRequest).toEqual({
      method: 'GET',
      pathAndQuery: '/simplefin/accounts?balances-only=1',
    });
  });
});

describe('the token-claim pairing seat', () => {
  const pairing = entry?.pairing;

  it('is discriminated as token-claim, leaving both siblings untouched', () => {
    expect(pairing?.kind).toBe('token-claim');
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['hue']?.pairing?.kind).toBe('exchange');
    expect(WELL_KNOWN_PROVIDERS_REGISTRY['whatsapp']?.pairing?.kind).toBe('device-link');
  });

  it('names BOTH mint targets, and they are the entry\'s own field pair in order', () => {
    // The mint fills two fields — the reason `secretField` (singular, both siblings)
    // could not be reused. Each must reference a declared field, in the injection
    // order the kind default reads.
    if (pairing?.kind !== 'token-claim') throw new Error('expected a token-claim seat');
    expect(pairing.usernameField).toBe('username');
    expect(pairing.passwordField).toBe('password');
    const keys = entry?.fields?.map((field) => field.key) ?? [];
    expect(keys).toEqual([pairing.usernameField, pairing.passwordField]);
  });

  it('pins the access path as a leading-slash PATH — never a URL, never a host', () => {
    // The seat cannot express a host (family discipline); `accessPath` is the checked
    // invariant the claim enforces on the RETURNED access URL (review Blocker 3): a
    // future bridge minting under a different prefix must refuse loudly at claim time,
    // not break silently mid-sync.
    if (pairing?.kind !== 'token-claim') throw new Error('expected a token-claim seat');
    expect(pairing.accessPath).toBe('/simplefin');
    expect(pairing.accessPath.startsWith('/')).toBe(true);
    expect(pairing.accessPath).not.toMatch(/:\/\/|\./);
  });

  it('REQUIRES a verify read, at the SAME spelling as the declared test probe (ADR-0025)', () => {
    // One path, two seats, zero drift: the verify read proves the minted pair before
    // the wizard claims connected, and the test button re-proves it later — if the two
    // spellings diverged, one of them is probing a path nobody vouched for.
    expect(pairing?.verify?.method).toBe('GET');
    expect(pairing?.verify?.pathAndQuery).toBe(entry?.testRequest?.pathAndQuery);
  });

  it('labels the paste box and tells the user what to do first', () => {
    if (pairing?.kind !== 'token-claim') throw new Error('expected a token-claim seat');
    expect(pairing.tokenLabel).toMatch(/setup token/i);
    expect(pairing.preconditionInstruction.length).toBeGreaterThan(20);
    expect(pairing.preconditionInstruction).toMatch(/token|SimpleFIN/i);
  });
});

describe('the emitter and admission handle the entry', () => {
  it('emits a requirement that the protocol schema accepts', () => {
    const requirement = requirementFromRegistryEntry(entry!, 'SimpleFIN', 'simplefin');
    expect(requirement.kind).toBe('basic_auth');
    expect(requirement.declaredApiHosts).toEqual(['beta-bridge.simplefin.org']);
    const parsed = connectionRequirementSchema.safeParse(requirement);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('emits a requirement that carries NO pairing data — the seat stays registry-side', () => {
    // ADR-0023 D2, restated for the third variant: a persisted requirement carrying
    // claim mechanics would be a channel through which a prompt-injected declaration
    // could aim an uncredentialed POST. The wizard re-resolves the registry at claim
    // time; the row never holds the seat.
    const requirement = requirementFromRegistryEntry(entry!, 'SimpleFIN', 'simplefin');
    expect(requirement).not.toHaveProperty('pairing');
  });

  it('admits its own emitted shape on the registry channel', () => {
    const requirement = requirementFromRegistryEntry(entry!, 'SimpleFIN', 'simplefin');
    const admitted = admitConnectionRequirement(requirement, { channel: 'registry' });
    expect(admitted.ok, JSON.stringify(admitted.issues ?? [])).toBe(true);
  });

  it('REFUSES a borrower that claims the SimpleFIN brand with its own host', () => {
    const hostile = {
      slot: 'simplefin',
      provider: { name: 'SimpleFIN' },
      kind: 'basic_auth' as const,
      fields: [
        { key: 'username', label: 'Access ID', type: 'text' as const },
        { key: 'password', label: 'Access key', type: 'secret' as const },
      ],
      declaredApiHosts: ['evil.example'],
    };
    const admitted = admitConnectionRequirement(hostile, { channel: 'inference' });
    expect(admitted.ok).toBe(false);
  });

  it('substitutes the pinned host over a bare starter borrow — the Ledger manifest path', () => {
    // The EXACT shape `examples/ledger/connection.json` ships (review N9): kind + host,
    // no fields, no registration — the borrow hit replaces the host and supplies the
    // pinned field list and walkthrough.
    const result = admitConnectionRequirement(
      {
        slot: 'simplefin',
        provider: { name: 'SimpleFIN' },
        kind: 'basic_auth',
        declaredApiHosts: ['beta-bridge.simplefin.org'],
      },
      { channel: 'starter' },
    );
    expect(result.ok, JSON.stringify(result.issues ?? [])).toBe(true);
    expect(result.borrowed).toBe(true);
    expect(result.borrowedFrom).toBe('simplefin');
    const requirement = result.requirement as {
      declaredApiHosts: string[];
      fields?: Array<{ key: string }>;
    };
    expect(requirement.declaredApiHosts).toEqual(['beta-bridge.simplefin.org']);
    expect(requirement.fields?.map((field) => field.key)).toEqual(['username', 'password']);
  });
});

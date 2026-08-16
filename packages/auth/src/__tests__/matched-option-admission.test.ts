// matched-option-admission.test.ts — TASK-20260812-auth-kind-choice, P1
// (AC5 restated + the D3 matched-option handle; the security phase).
//
// THE BLOCKER THIS CLOSES (plan review B1/B2, verified before any code): Guard 2b has
// two halves, and they disagreed about variants. The REFUSAL half (`occupiedPromptSeats`)
// could learn to bless a variant's field list, but the SUBSTITUTION half
// (`applyRegistryValues`) wrote the DEFAULT entry's fields unconditionally on every
// borrow hit on every channel — so a user-chosen OAuth variant would persist as the
// OAuth kind wearing the api_key field list, the user's choice silently undone. The fix
// is ONE matched-option handle driving BOTH halves: the option whose pinned field list
// the declaration matches byte-identically is the option whose flow seats substitution
// honors. The two halves can no longer disagree about which human-reviewed option a
// requirement came from.
//
// INVARIANTS THAT MUST SURVIVE THE CHANGE, asserted per option path: hosts are ALWAYS
// replaced with the entry's (a flow choice never moves which hosts get the credential);
// the provider name is always pinned; the borrower's KIND is never substituted (parent
// D6/AC10); an edited list is still refused on borrowing channels.

import { describe, expect, it } from 'vitest';

import { admitConnectionRequirement } from '../requirement-admission.js';
import { WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

const coinbase = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
const coinbaseOauth = coinbase.authOptions![0]!;
const github = WELL_KNOWN_PROVIDERS_REGISTRY['github']!;
const githubOauth = github.authOptions![0]!;

type AdmittedShape = {
  kind: string;
  fields?: Array<{ key: string; label: string }>;
  endpoints?: { authorizeUrl?: string; tokenUrl?: string };
  declaredApiHosts: string[];
  provider: { name: string };
};

describe("AC5 — the 'user' channel rebind: a chosen variant's list is blessed AND survives substitution", () => {
  it("Coinbase OAuth variant on channel 'user': admitted, and POST-SUBSTITUTION fields are the VARIANT's", () => {
    const result = admitConnectionRequirement(
      {
        slot: 'coinbase',
        provider: { name: 'Coinbase' },
        kind: 'oauth2_auth_code',
        fields: coinbaseOauth.fields!.map((field) => ({ ...field })),
        endpoints: { ...coinbaseOauth.endpoints! },
        pkce: true,
        declaredApiHosts: ['api.coinbase.com'],
      },
      { channel: 'user' },
    );

    expect(result.ok, 'the pinned variant list is not an authoring act').toBe(true);
    expect(result.borrowed).toBe(true);
    const admitted = result.requirement as AdmittedShape;
    // THE B1 ASSERTION: the variant's client_id field survives; the default
    // [api_key, api_secret, passphrase] must NOT be written over the user's choice.
    expect(admitted.fields?.map((field) => field.key)).toEqual(['client_id']);
    expect(admitted.endpoints?.authorizeUrl).toBe('https://login.coinbase.com/oauth2/auth');
    // Identity invariants hold on the variant path exactly as on the default path.
    // `!` since P5 widened the seat (apiHosts XOR lanHost, ADR-0023). Coinbase is a
    // pinned-host entry — a LAN entry reaching this assertion would be the bug.
    expect(admitted.declaredApiHosts).toEqual([...coinbase.apiHosts!]);
    expect(admitted.provider.name).toBe('Coinbase');
  });

  it("GitHub OAuth-app variant on channel 'starter': same handle, same fidelity", () => {
    const result = admitConnectionRequirement(
      {
        slot: 'github',
        provider: { name: 'GitHub' },
        kind: 'oauth2_auth_code',
        fields: githubOauth.fields!.map((field) => ({ ...field })),
        declaredApiHosts: ['api.github.com'],
      },
      { channel: 'starter' },
    );

    expect(result.ok).toBe(true);
    const admitted = result.requirement as AdmittedShape;
    expect(admitted.fields?.map((field) => field.key)).toEqual(['client_id', 'client_secret']);
  });

  it('the DEFAULT list still matches and still substitutes the default (regression)', () => {
    const result = admitConnectionRequirement(
      {
        slot: 'coinbase',
        provider: { name: 'Coinbase' },
        kind: 'api_key',
        fields: coinbase.fields!.map((field) => ({ ...field })),
        declaredApiHosts: ['api.coinbase.com'],
      },
      { channel: 'starter' },
    );
    expect(result.ok).toBe(true);
    // MIGRATED 2026-08-13 (P3 Coinbase CDP rewrite): the default list is the CDP pair.
    expect((result.requirement as AdmittedShape).fields?.map((field) => field.key)).toEqual([
      'api_key',
      'ed25519_private_key',
    ]);
  });

  it('an EDITED variant list is still an authoring act — refused (negative half)', () => {
    const tampered = coinbaseOauth.fields!.map((field) => ({ ...field }));
    tampered[0] = { ...tampered[0]!, label: 'Paste your Coinbase password' };
    const result = admitConnectionRequirement(
      {
        slot: 'coinbase',
        provider: { name: 'Coinbase' },
        kind: 'oauth2_auth_code',
        fields: tampered,
        declaredApiHosts: ['api.coinbase.com'],
      },
      { channel: 'user' },
    );
    expect(result.ok, 'one relabelled input is an authored list, not the pinned value').toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('fields');
  });

  it('B2 is dead: matching a VARIANT list can never receive the DEFAULT shape (or vice versa)', () => {
    // The mix-and-match the review constructed: pass variant fields, get default
    // fields substituted. With the single handle, whichever list matched is the list
    // (and endpoints) that comes back — asserted for both options of both entries.
    for (const [entry, option, channel] of [
      [coinbase, coinbaseOauth, 'inference'],
      [github, githubOauth, 'inference'],
    ] as const) {
      const result = admitConnectionRequirement(
        {
          slot: 'x',
          provider: { name: entry.displayName! },
          kind: option.kind,
          fields: option.fields!.map((field) => ({ ...field })),
          declaredApiHosts: ['evil.example'],
        },
        { channel },
      );
      expect(result.ok).toBe(true);
      const admitted = result.requirement as AdmittedShape;
      expect(admitted.fields).toEqual(option.fields);
      // Hosts are STILL replaced on the variant path — evil.example is gone. `!` since
      // P5 widened the seat (apiHosts XOR lanHost, ADR-0023): only multi-OPTION entries
      // reach here, and a LAN entry may declare no options at all (pinned by
      // well-known-providers.test.ts), so this loop is pinned-host by construction.
      expect(entry.apiHosts, 'an entry with authOptions pins hosts').toBeDefined();
      expect(admitted.declaredApiHosts).toEqual([...entry.apiHosts!]);
      expect(admitted.declaredApiHosts).not.toContain('evil.example');
    }
  });

  it("the borrower's KIND is still never substituted on any option path (parent D6/AC10)", () => {
    // A declaration matching the DEFAULT api_key list while claiming oauth2_auth_code
    // keeps its own (wrong) kind — the ban stays kind-agnostic; only WHICH option's
    // flow seats substitution honors changed.
    const result = admitConnectionRequirement(
      {
        slot: 'x',
        provider: { name: 'Coinbase' },
        kind: 'oauth2_auth_code',
        fields: coinbase.fields!.map((field) => ({ ...field })),
        declaredApiHosts: ['api.coinbase.com'],
      },
      { channel: 'starter' },
    );
    expect(result.ok).toBe(true);
    expect((result.requirement as AdmittedShape).kind).toBe('oauth2_auth_code');
  });
});

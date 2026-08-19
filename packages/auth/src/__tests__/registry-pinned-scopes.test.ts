// TASK-20260815-spotify-scopes-wizard-links AC1/AC2 (ADR-0028) — RED-FIRST at Gate 3
// against a registry that pins no scopes anywhere and an emitter/substitution pair that
// never read the seat.
//
// ADR-0028 amends the standing "no default scopes" posture: a registry ENTRY may pin a
// human-reviewed scope list (entry-level ONLY — privilege breadth is brand identity,
// like display name and hosts; options never carry it). The seat rides every surface
// pinned seats ride: emitted by `requirementFromRegistryEntry`, REPLACED (never merged)
// by admission's registry substitution on every borrow hit, carried into the spec by
// `requirementToSpec`, and sent by `generateAuthUrl`. AC1's test runs that WHOLE chain
// at the production altitude (lesson 2026-08-05: test where the decision is made — a
// hand-built spec would pass against a broken emitter).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ConnectionRequirement } from '@snugprotocol/protocol';
import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
} from '../well-known-providers.js';
import { admitConnectionRequirement } from '../requirement-admission.js';
import { requirementToSpec } from '../connected-fetch.js';
import { OAuthService } from '../oauth-service.js';
import { UserDbCredentialStore } from '../credential-store.js';

// The ADR-0028 §4 set, verbatim and ORDERED (scopes are semantically ordered — the
// review screen and the consent screen render them in this order).
// AMENDED 2026-08-19 (TASK-20260819-connection-failure-ux): `user-read-recently-played`
// joins the set. Rewind ships a complete recently-played lane (`recentMetrics`, the
// recent-chips row, the second branch of the discovery caption) that the original pin
// left unreachable — and the resulting expected-403 raised the auth-repair alarm on
// every launch of a perfectly healthy connection. ADR-0028 §4 amendment records the
// consent tradeoff.
const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-private',
  'user-library-read',
  'user-top-read',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-recently-played',
];

// The ADR-0039 set — the SECOND ADR-0028 pin (TASK-20260819-gmail-starter). Ordered:
// the review and consent screens render them in this order, widest-first.
//
// Three scopes, each load-bearing for Inbox Copilot: `gmail.modify` is the cleanup core
// (read, label, trash, mark-spam); `gmail.settings.basic` is what auto-trash rules and
// sender blocking actually ARE (Gmail filters are a settings resource, not a message
// op); `gmail.send` sends the mailto: half of List-Unsubscribe as a confirmed write.
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.send',
];

/** The full-access scope ADR-0039 D3 REFUSES — the only Gmail scope that can permanently delete. */
const GMAIL_FULL_ACCESS_SCOPE = 'https://mail.google.com/';

/**
 * The shipped starter manifest — READ from the file that ships, not retyped (Gate-5
 * review: a hand copy claiming "byte-shaped" keeps passing after the real manifest
 * changes, and the whole point of the AC1 chain test is that THE SHIPPED declaration
 * reaches a scoped authorize URL).
 */
const STARTER_DECLARATION = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../examples/spotify/connection.json', import.meta.url)),
    'utf8',
  ),
) as ConnectionRequirement;

function memoryQuartet(): {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
} {
  const map = new Map<string, string>();
  return {
    getSecret: (key) => map.get(key),
    setSecret: (key, value) => void map.set(key, value),
    deleteSecret: (key) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

describe('ADR-0028 — the Spotify entry pins its reviewed scope set', () => {
  it('pins exactly the ADR-0028 set, in its recorded order', () => {
    expect(lookupWellKnownProvider('Spotify')?.scopes).toEqual(SPOTIFY_SCOPES);
  });

  it('TASK-20260819 AC1: pins user-read-recently-played — Rewind\'s built lane is reachable', () => {
    // Named EXPLICITLY rather than resting on the set equality above: this one scope is
    // the whole point of the task, and a future set edit that drops it should fail with
    // a sentence that says why it mattered, not just a diff of two arrays.
    expect(lookupWellKnownProvider('Spotify')?.scopes).toContain('user-read-recently-played');
  });

  it('user-read-email stays deliberately excluded (no Snug surface needs the address)', () => {
    expect(lookupWellKnownProvider('Spotify')?.scopes).not.toContain('user-read-email');
  });
});

describe('ADR-0028 — the emitter emits scopes as an ENTRY-level seat', () => {
  it('emits the pinned set for Spotify, as a COPY (registry is a module singleton)', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
    const requirement = requirementFromRegistryEntry(entry, 'Spotify', 'spotify');
    expect(requirement.scopes).toEqual(SPOTIFY_SCOPES);
    expect(requirement.scopes).not.toBe(entry.scopes);
  });

  it('emits NO scopes for entries that pin none (the posture survives for them)', () => {
    const google = WELL_KNOWN_PROVIDERS_REGISTRY['google']!;
    expect(requirementFromRegistryEntry(google, 'Google', 'google').scopes).toBeUndefined();
  });
});

describe('ADR-0028 — admission substitution owns the seat on every borrow hit', () => {
  it('a bare starter declaration under the Spotify brand receives the pinned scopes', () => {
    const admitted = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(admitted.ok, 'the shipped manifest must stay admissible').toBe(true);
    if (admitted.ok) expect(admitted.requirement.scopes).toEqual(SPOTIFY_SCOPES);
  });

  it('REPLACES authored scopes under a scope-pinned brand — a borrower can neither widen nor narrow', () => {
    const authored: ConnectionRequirement = { ...STARTER_DECLARATION, scopes: ['user-read-email'] };
    const admitted = admitConnectionRequirement(authored, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.requirement.scopes).toEqual(SPOTIFY_SCOPES);
      expect(admitted.requirement.scopes).not.toContain('user-read-email');
    }
  });

  it('CHARACTERIZATION (ADR-0028 rule 5, pre-existing exposure): authored scopes SURVIVE under a non-scope-pinned brand', () => {
    // This pins today's behavior so the threat-model pass that revisits rule 5 (parked
    // beside borrowed-endpoints, next-steps 2026-08-12) inherits a test, not a guess.
    // AC3b is the mitigation: the widened ask renders in-wizard before any approval.
    const authored: ConnectionRequirement = {
      slot: 'google',
      provider: { name: 'Google' },
      kind: 'oauth2_auth_code',
      declaredApiHosts: ['www.googleapis.com'],
      scopes: ['https://mail.google.com/'],
    };
    const admitted = admitConnectionRequirement(authored, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.requirement.scopes).toEqual(['https://mail.google.com/']);
  });

  it('NEGATIVE (Gate-5): a STATIC-kind declaration under the Spotify brand gains NO scopes — the seat is meaningless to its kind', () => {
    // Admission never substitutes kind, so without this gate every legacy api_key row
    // brand-resolving to a scope-pinned entry would stage a spurious "what this sign-in
    // may do" diff at wizard open and route its user through a re-consent ceremony
    // scopes cannot affect.
    const staticDeclaration: ConnectionRequirement = {
      slot: 'spotify',
      provider: { name: 'Spotify' },
      kind: 'api_key',
      declaredApiHosts: ['api.spotify.com'],
    };
    const admitted = admitConnectionRequirement(staticDeclaration, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.requirement.scopes).toBeUndefined();
  });

  it('substitution hands out COPIES — scopes and registration.instructions are never live registry references', () => {
    const admitted = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
    expect(admitted.requirement.scopes).not.toBe(entry.scopes);
    // The plan-review drive-by: registration was shallow-spread, leaving `instructions`
    // a live reference to the module singleton every later substitution reads.
    expect(admitted.requirement.registration?.instructions).not.toBe(entry.registration?.instructions);
  });

  it('is idempotent across the second admission pass (the production path admits twice)', () => {
    const first = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = admitConnectionRequirement(first.requirement, { channel: 'starter' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.requirement.scopes).toEqual(SPOTIFY_SCOPES);
  });
});

describe('AC1 — the WHOLE production chain: manifest → admission → spec → authorize URL', () => {
  it('the authorize URL carries scope= with exactly the pinned set, space-joined, in order', async () => {
    const admitted = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const spec = requirementToSpec(admitted.requirement);
    expect(spec, 'an oauth requirement must produce a spec').not.toBeNull();

    const service = new OAuthService({
      store: new UserDbCredentialStore(memoryQuartet()),
      redirectUriProvider: { redirectUri: () => 'http://127.0.0.1:41420/callback' },
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const start = await service.generateAuthUrl({
      appId: 'app-spotify-starter',
      spec: spec!,
      clientCreds: { client_id: 'CID' },
    });
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('scope')).toBe(SPOTIFY_SCOPES.join(' '));
    // PKCE stays active through the same chain — the scope seat must not displace it.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// TASK-20260819-gmail-starter (ADR-0039) — the SECOND ADR-0028 pin.
//
// RED-FIRST at Gate 3 against a `gmail` entry that pins no scopes, no fields, and no
// registration walkthrough — recorded in next-steps item (7) as a wizard journey that
// dead-ends. The starter cannot connect until all three land, so all three are pinned
// here rather than left to the app.
// ───────────────────────────────────────────────────────────────────────────────

describe('ADR-0039 AC1 — the Gmail entry pins its reviewed scope set', () => {
  it('pins exactly the ADR-0039 set, in its recorded order', () => {
    expect(lookupWellKnownProvider('Gmail')?.scopes).toEqual(GMAIL_SCOPES);
  });

  it('NEGATIVE (ADR-0039 D3): never pins https://mail.google.com/ — trash-only is STRUCTURAL', () => {
    // The load-bearing negative of the whole starter. `messages.delete`/`batchDelete`
    // require the full-access scope; withholding it means the minted token CANNOT
    // permanently delete a user's mail no matter what the app code asks for. If a later
    // edit adds this scope, "your mail is only ever moved to Trash" stops being a
    // property of the token and becomes a promise made by app code — a demotion the
    // ADR forbids, and one no app-side test could catch.
    expect(lookupWellKnownProvider('Gmail')?.scopes).not.toContain(GMAIL_FULL_ACCESS_SCOPE);
  });

  it('pins gmail.settings.basic — auto-trash rules and sender blocking ARE filters', () => {
    // Named explicitly: it is the least obvious of the three (a reader reasonably
    // assumes gmail.modify covers "block this sender"), so a future trim should fail
    // with a sentence naming the feature that dies rather than an array diff.
    expect(lookupWellKnownProvider('Gmail')?.scopes).toContain(
      'https://www.googleapis.com/auth/gmail.settings.basic',
    );
  });

  it('the sibling Google entries stay unpinned — this pin is Gmail-shaped, not Google-wide', () => {
    expect(lookupWellKnownProvider('Google')?.scopes).toBeUndefined();
    expect(lookupWellKnownProvider('Google Drive')?.scopes).toBeUndefined();
  });
});

describe('ADR-0039 AC2 — the Gmail entry ships the credential fields the wizard renders', () => {
  it('pins BOTH client_id and client_secret — Google refuses the exchange without the secret', () => {
    // PROBED 2026-08-19 (task step 0). Google's native-app parameter table lists
    // `client_secret` as "Optional", but the token endpoint REFUSES a Desktop-client
    // code exchange without it — `client_secret is missing.` — even with a valid
    // `code_verifier`. Google's own guidance is that an installed app's secret "is not
    // treated as a secret"; the Coinbase lesson (a stale docs page read as truth) is
    // exactly why this was probed before the walkthrough copy was written. Pinning only
    // `client_id` here would ship a wizard that completes consent and then dies at the
    // exchange with a provider error the user cannot act on.
    const fields = lookupWellKnownProvider('Gmail')?.fields;
    expect(fields?.map((field) => field.key)).toEqual(['client_id', 'client_secret']);
  });

  it('every pinned field is renderable — a key, a label, and a type the wizard understands', () => {
    for (const field of lookupWellKnownProvider('Gmail')?.fields ?? []) {
      expect(field.key, 'a field with no key cannot be stored').toMatch(/^\S+$/);
      expect(field.label.length, `${field.key}: needs a human label`).toBeGreaterThan(0);
      expect(['text', 'password'], `${field.key}: unknown input type`).toContain(field.type);
    }
  });

  it('the client_secret field is masked — a pasted secret never renders in clear text', () => {
    const secret = lookupWellKnownProvider('Gmail')?.fields?.find((f) => f.key === 'client_secret');
    expect(secret?.type).toBe('password');
  });
});

describe('ADR-0039 AC2 — the Gmail walkthrough is layman-grade and provider-honest', () => {
  it('links the Google Cloud console', () => {
    expect(lookupWellKnownProvider('Gmail')?.registration?.consoleUrl).toBe(
      'https://console.cloud.google.com/auth/clients',
    );
  });

  it('walks the whole journey — project, Gmail API, consent screen, Desktop client, credentials', () => {
    const steps = lookupWellKnownProvider('Gmail')?.registration?.instructions ?? [];
    expect(steps.length, 'a five-stop journey cannot be four steps').toBeGreaterThanOrEqual(5);
    const walkthrough = steps.join('\n').toLowerCase();
    for (const beat of ['project', 'gmail api', 'desktop', 'client id', 'client secret']) {
      expect(walkthrough, `the walkthrough never mentions: ${beat}`).toContain(beat);
    }
  });

  it('discloses the 7-day Testing-mode expiry — the Spotify development-mode precedent', () => {
    // Spotify's entry documents its development-mode traps (five users, Premium owner)
    // because a silent provider limit surfaces as "Snug is broken". Google's equivalent
    // is harsher and time-delayed: a project left in Testing status mints refresh tokens
    // that expire after SEVEN DAYS, so a connection that worked all week dies on day
    // eight and the user has no way to know why.
    const walkthrough = (lookupWellKnownProvider('Gmail')?.registration?.instructions ?? []).join('\n');
    expect(walkthrough).toMatch(/7 days|seven days/i);
    expect(walkthrough.toLowerCase()).toContain('testing');
  });

  it('never promises "no client secret" — the copy must match the probed exchange', () => {
    // The Spotify walkthrough legitimately says "PKCE needs no secret". Transplanting
    // that sentence onto Google would be a lie the user discovers at the exchange.
    const walkthrough = (lookupWellKnownProvider('Gmail')?.registration?.instructions ?? []).join('\n');
    expect(walkthrough).not.toMatch(/no (client )?secret|never needs? (a )?(client )?secret/i);
  });
});

describe('ADR-0039 AC1 — the whole production chain for Gmail: entry → spec → authorize URL', () => {
  it('the authorize URL carries the pinned scopes, PKCE, and Google offline consent', async () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['gmail']!;
    const requirement = requirementFromRegistryEntry(entry, 'Gmail', 'gmail');
    expect(requirement.scopes).toEqual(GMAIL_SCOPES);
    expect(requirement.scopes, 'the registry is a module singleton — emit copies').not.toBe(
      entry.scopes,
    );

    const spec = requirementToSpec(requirement);
    expect(spec, 'an oauth requirement must produce a spec').not.toBeNull();

    const service = new OAuthService({
      store: new UserDbCredentialStore(memoryQuartet()),
      redirectUriProvider: { redirectUri: () => 'http://127.0.0.1:41420/callback' },
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const start = await service.generateAuthUrl({
      appId: 'app-gmail-starter',
      spec: spec!,
      clientCreds: { client_id: 'CID' },
    });
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The refresh token the whole connection depends on only arrives with both of these
    // — they are why the entry carries GOOGLE_AUTHORIZE_PARAMS.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('a bare starter manifest under the Gmail brand receives the pinned scopes and fields', () => {
    // The manifest examples/gmail/connection.json ships BARE (hue precedent); admission's
    // registry substitution is what turns it into a connectable requirement. Declared
    // inline here rather than read from disk: this suite is RED before the starter
    // exists, and Slice A must be able to go green on its own.
    const bare: ConnectionRequirement = {
      slot: 'gmail',
      provider: { name: 'Gmail' },
      kind: 'oauth2_auth_code',
      declaredApiHosts: ['gmail.googleapis.com'],
    };
    const admitted = admitConnectionRequirement(bare, { channel: 'starter' });
    expect(admitted.ok, 'the shipped manifest must stay admissible').toBe(true);
    if (!admitted.ok) return;
    expect(admitted.requirement.scopes).toEqual(GMAIL_SCOPES);
    expect(admitted.requirement.fields?.map((f) => f.key)).toEqual(['client_id', 'client_secret']);
    expect(admitted.requirement.registration?.consoleUrl).toBe(
      'https://console.cloud.google.com/auth/clients',
    );
  });

  it('REPLACES an authored widening — a borrower cannot smuggle in full mail access', () => {
    // The ADR-0028 rule-2 REPLACE semantics, exercised on the scope this starter most
    // needs kept out. A future app declaring `https://mail.google.com/` under the Gmail
    // brand gets the pinned three and nothing else.
    const greedy: ConnectionRequirement = {
      slot: 'gmail',
      provider: { name: 'Gmail' },
      kind: 'oauth2_auth_code',
      declaredApiHosts: ['gmail.googleapis.com'],
      scopes: [GMAIL_FULL_ACCESS_SCOPE],
    };
    const admitted = admitConnectionRequirement(greedy, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.requirement.scopes).toEqual(GMAIL_SCOPES);
    expect(admitted.requirement.scopes).not.toContain(GMAIL_FULL_ACCESS_SCOPE);
  });
});

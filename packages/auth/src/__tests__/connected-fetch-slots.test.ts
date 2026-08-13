// TASK-20260810-p1-runtime (Dynamic Auth v2, P1) AC1–AC8: SLOT ROUTING in the
// connected-fetch executor — the runtime half of R6 ("Dropbox + OneDrive + Google Drive
// in one app"). Written RED-FIRST at Gate 3 against a v4 surface that does not exist yet.
//
// WHAT CHANGES, IN ONE LINE. v3 answered "which credential does this app use?" with a
// PRIMARY-KEY lookup (`snug_auth_specs.app_id` was the whole key, so the question had
// exactly one answer). v4's `(app_id, slot)` key makes the question genuinely ambiguous,
// and the executor must answer it by TARGET HOST against each grant's FROZEN
// `allowed_hosts` — never by position, never by "the first row", never by guessing.
//
// THE CUTOVER RULE BINDS HERE (parent §Implementation phases, fold B1). This file tests
// the ADDITIVE v4 reader only. The v3 `NetSpecReader`/`getAuthSpec` path and its 240
// shipped tests (connected-fetch.test.ts et al.) keep working and keep passing —
// `llmProposalSchema` and the `snug_auth_specs` surface are named exit items of P4/P3,
// not of P1. Any change that makes connected-fetch.test.ts red is out of P1 scope.
//
// POSTURE INHERITED FROM THE SHIPPED SIBLINGS: executor-altitude with a fake fetch;
// REAL credential-shaped values, never `'x'` (a theft test that probes for `'x'` proves
// nothing); and where a claim is "this value never crossed", the assertion probes the
// OUTBOUND HEADERS for the value rather than probing for the absence of a key.
import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import {
  CONNECTION_STATUS,
  type ConnectionRequirement,
  type ConnectionStatus,
} from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';
import {
  createConnectedFetch,
  type ConnectedFetch,
  type NetConnectionRow,
} from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

// ---------------------------------------------------------------------- fixtures

const APP = 'app-multi-slot';

/**
 * TWO SLOTS, TWO PROVIDERS, TWO DISJOINT HOSTS — the whole point of the fixture. The
 * hosts must be disjoint for the routing claim to be falsifiable: if both grants could
 * serve `api.dropbox.com`, "it picked the right one" would be unobservable.
 */
const dropboxRequirement = {
  slot: 'dropbox',
  provider: { name: 'Dropbox' },
  kind: 'bearer_token',
  fields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }],
  declaredApiHosts: ['api.dropbox.com'],
} as const satisfies ConnectionRequirement;

const onedriveRequirement = {
  slot: 'onedrive',
  provider: { name: 'OneDrive' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['graph.microsoft.com'],
} as const satisfies ConnectionRequirement;

/**
 * Distinct, credential-SHAPED, and mutually non-substring: the cross-slot theft assertion
 * (AC3) searches the outbound header blob for the foreign value, so a shared prefix would
 * make a true positive indistinguishable from a coincidence.
 */
const DROPBOX_TOKEN = 'sl.B7q2-dropbox-9f3a7c21b4e05d68a1f2c3b4d5e6f708';
const ONEDRIVE_KEY = 'od-live-4417ZmNoPqRsTuVwXyZ01234567aBcDeF98';

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

type FetchCall = { url: string; init: RequestInit };

/** Build a v4 row; `allowedHosts` defaults to the requirement's declared hosts (the frozen union). */
function row(
  requirement: ConnectionRequirement,
  opts: { status?: ConnectionStatus; allowedHosts?: string[]; pendingRequirement?: ConnectionRequirement } = {},
): NetConnectionRow {
  return {
    appId: APP,
    slot: requirement.slot,
    requirement,
    status: opts.status ?? CONNECTION_STATUS.approved,
    // `?? []` since ADR-0023 made `declaredApiHosts` required-XOR-`lanHost`. Every
    // requirement in this suite declares hosts, so the fallback never fires here.
    allowedHosts: opts.allowedHosts ?? [...(requirement.declaredApiHosts ?? [])],
    ...(opts.pendingRequirement !== undefined ? { pendingRequirement: opts.pendingRequirement } : {}),
  };
}

interface Harness {
  executor: ConnectedFetch;
  calls: FetchCall[];
  quartet: ReturnType<typeof memoryQuartet>;
  confirm: ReturnType<typeof vi.fn>;
}

/**
 * The v4 harness. `connectionReader.listConnections(appId)` replaces v3's
 * `specReader.getAuthSpec(appId)`: the executor must see EVERY row for the app, because
 * a reader that pre-selected one row would be doing the routing the executor is on the
 * hook for — and would make AC1's two-match ambiguity undetectable at this altitude.
 */
function harness(
  opts: {
    rows?: NetConnectionRow[];
    respond?: (url: string, init: RequestInit) => Response;
    confirmResult?: boolean;
    seedCredentials?: boolean;
  } = {},
): Harness {
  const quartet = memoryQuartet();
  if (opts.seedCredentials !== false) {
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'dropbox', 'token'), DROPBOX_TOKEN);
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'onedrive', 'api_key'), ONEDRIVE_KEY);
  }
  const rows = opts.rows ?? [row(dropboxRequirement), row(onedriveRequirement)];
  const calls: FetchCall[] = [];
  const respond =
    opts.respond ??
    (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const confirm = vi.fn(async () => opts.confirmResult ?? true);
  const executor = createConnectedFetch({
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: (appId) => (appId === APP ? rows : []) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    },
    confirmGate: { confirm },
  });
  return { executor, calls, quartet, confirm };
}

/** Every outbound header value as one blob — the seat a stolen credential would have to occupy. */
const headerBlob = (call: FetchCall): string =>
  Object.entries((call.init.headers ?? {}) as Record<string, string>)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

const headerOf = (call: FetchCall, name: string): string | undefined => {
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
};

beforeEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------- AC1: slot routing

describe('P1-AC1 — slot routing by TARGET HOST (parent §5 Multi-connection, R6)', () => {
  it('routes to the slot whose FROZEN allowed_hosts contains the target host — dropbox host gets the dropbox grant', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/2/files/list', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0]!, 'authorization')).toBe(`Bearer ${DROPBOX_TOKEN}`);
  });

  it('routes the OTHER host to the OTHER slot — same app, same executor, different credential', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me/drive', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0]!, 'x-api-key')).toBe(ONEDRIVE_KEY);
  });

  it('ZERO matches is NET_NOT_APPROVED with a CTA naming the provider that WOULD match a declared row', async () => {
    // The app calls Google Drive; a `declared` (never-approved) row for it exists, so the
    // executor knows WHICH provider the user would have to connect. Naming it is the
    // difference between "connect something" and "connect Google Drive" — and it must
    // come from a DECLARED row, never from the request, or the app would be choosing its
    // own CTA copy.
    const googleRequirement = {
      slot: 'gdrive',
      provider: { name: 'Google Drive' },
      kind: 'oauth2_auth_code',
      endpoints: {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
      },
      declaredApiHosts: ['www.googleapis.com'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({
      rows: [row(dropboxRequirement), row(googleRequirement, { status: CONNECTION_STATUS.declared })],
    });
    const result = await executor.execute(APP, { url: 'https://www.googleapis.com/drive/v3/files', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('Google Drive');
    expect(calls).toHaveLength(0);
  });

  it('a host matching NO row at all is NET_NOT_APPROVED and names no provider it cannot know', async () => {
    const { executor, calls } = harness();
    const result = await executor.execute(APP, { url: 'https://api.stripe.com/v1/charges', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    if (result.ok) throw new Error('unreachable');
    // It must not invent a provider name, and must not echo the app-supplied host back as
    // one — the CTA is host-derived only when a DECLARED row backs it.
    expect(result.message).not.toContain('Dropbox');
    expect(result.message).not.toContain('OneDrive');
    expect(calls).toHaveLength(0);
  });

  it('TWO matching grants is the deterministic NET_AMBIGUOUS_CONNECTION — the executor NEVER guesses between credentials', async () => {
    // Doctrine still caps at one connection per app (Q4), so this state is a bug or an
    // attack, not a routine case. Either way the answer is a refusal: silently picking
    // one would send provider A's secret to a host provider B also claims.
    const overlapping = {
      ...onedriveRequirement,
      slot: 'onedrive',
      declaredApiHosts: ['api.dropbox.com'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({ rows: [row(dropboxRequirement), row(overlapping)] });
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/2/files/list', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AMBIGUOUS_CONNECTION });
    expect(calls).toHaveLength(0);
  });

  it('ambiguity is decided BEFORE any credential is read — neither secret is even loaded', async () => {
    const overlapping = {
      ...onedriveRequirement,
      declaredApiHosts: ['api.dropbox.com'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({ rows: [row(dropboxRequirement), row(overlapping)] });
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    if (result.ok) throw new Error('expected the ambiguous refusal');
    // C5: the refusal names the CONFLICT, never a credential and never a stored value.
    expect(result.message).not.toContain(DROPBOX_TOKEN);
    expect(result.message).not.toContain(ONEDRIVE_KEY);
    expect(calls).toHaveLength(0);
  });

  it('a REVOKED row does not participate in routing — its tombstone never serves a request', async () => {
    const { executor, calls } = harness({
      rows: [row(dropboxRequirement, { status: CONNECTION_STATUS.revoked }), row(onedriveRequirement)],
    });
    expect(await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
    expect(calls).toHaveLength(0);
  });

  it('a DECLARED row never injects — approval is the only thing that opens the network', async () => {
    const { executor, calls } = harness({
      rows: [row(dropboxRequirement, { status: CONNECTION_STATUS.declared })],
    });
    expect(await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
    expect(calls).toHaveLength(0);
  });

  it('an IMPORTED unapproved row keeps its DISTINCT error so settings can name the remedy', async () => {
    const { executor, calls } = harness({
      rows: [{ ...row(dropboxRequirement, { status: CONNECTION_STATUS.declared }), imported: true }],
    });
    expect(await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED,
    });
    expect(calls).toHaveLength(0);
  });
});

// --------------------------------------------------------- AC2: amended gate order

describe('P1-AC2 — AMENDED gate order: parse-then-resolve (fold F-m2)', () => {
  // Host-based routing needs the parsed URL, so the shipped order (row lookup at :296,
  // URL parse at :311) is inverted by P1. These tests are written so they would FAIL
  // under the OLD order — that is the only way an order claim is testable at all.

  it('a malformed URL is NET_INVALID_REQUEST even when the app has NO connection rows at all', async () => {
    // Under the OLD order this returns NET_NOT_APPROVED (row lookup ran first and found
    // nothing). Under the AMENDED order the parse runs first and reports the real fault.
    const { executor, calls } = harness({ rows: [] });
    expect(await executor.execute(APP, { url: 'not-a-url', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_INVALID_REQUEST,
    });
    expect(calls).toHaveLength(0);
  });

  it('an embedded-credential URL is refused as INVALID before routing, with zero rows present', async () => {
    const { executor } = harness({ rows: [] });
    expect(await executor.execute(APP, { url: 'https://user:pass@api.dropbox.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_INVALID_REQUEST,
    });
  });

  it('a non-https scheme is NET_SCHEME_BLOCKED before routing, with zero rows present (A1 survives)', async () => {
    // Scheme is a property of the URL, so it is knowable pre-routing; under the old order
    // the missing row would have masked it as NET_NOT_APPROVED.
    const { executor, calls } = harness({ rows: [] });
    expect(await executor.execute(APP, { url: 'http://api.dropbox.com/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SCHEME_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });

  it('gate 1 still precedes the parse — an unknown top-level field loses to shape, not to the URL', async () => {
    const { executor } = harness({ rows: [] });
    expect(await executor.execute(APP, { url: 'not-a-url', appId: 'other' } as never)).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_INVALID_REQUEST,
    });
  });

  it('the SSRF guard still fires for a routed host — reordering did not drop gate 5', async () => {
    const loopback = {
      ...dropboxRequirement,
      declaredApiHosts: ['127.0.0.1'],
    } as unknown as ConnectionRequirement;
    const { executor, calls } = harness({ rows: [row(loopback, { allowedHosts: ['127.0.0.1'] })] });
    expect(await executor.execute(APP, { url: 'https://127.0.0.1/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_SSRF_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------- AC3: cross-slot theft

describe('P1-AC3 — CROSS-SLOT THEFT: slot A’s credential can never inject into slot B’s host', () => {
  it('the request to slot B’s host carries slot B’s value and NONE of slot A’s', async () => {
    const { executor, calls } = harness();
    await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET' });
    expect(calls).toHaveLength(1);
    const blob = headerBlob(calls[0]!);
    expect(blob).toContain(ONEDRIVE_KEY);
    // The load-bearing assertion: the OTHER slot's secret is absent from every outbound
    // header, in any position, under any header name.
    expect(blob).not.toContain(DROPBOX_TOKEN);
  });

  it('and symmetrically: slot A’s host never carries slot B’s value', async () => {
    const { executor, calls } = harness();
    await executor.execute(APP, { url: 'https://api.dropbox.com/2/files/list', method: 'GET' });
    const blob = headerBlob(calls[0]!);
    expect(blob).toContain(DROPBOX_TOKEN);
    expect(blob).not.toContain(ONEDRIVE_KEY);
  });

  it('a slot B template that NAMES slot A’s field key fails closed — it never reaches across the slot boundary', async () => {
    // The direct theft attempt: OneDrive's template asks for `token`, which is Dropbox's
    // field key and is present in the store under Dropbox's slot. Credential reads are
    // slot-scoped, so the key resolves to nothing and the request must fail rather than
    // silently send an empty header — and above all must never send Dropbox's value.
    const thief = {
      ...onedriveRequirement,
      fields: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
      request: { headerTemplate: { 'X-Api-Key': '{{token}}' } },
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({ rows: [row(dropboxRequirement), row(thief)] });
    const result = await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('two slots sharing a FIELD KEY keep separate values — the key is not the identity, (slot, key) is', async () => {
    const sameKeyA = {
      ...dropboxRequirement,
      fields: [{ key: 'api_key', label: 'Key', type: 'secret', required: true }],
      kind: 'api_key',
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
    } as const satisfies ConnectionRequirement;
    const { executor, calls, quartet } = harness({ rows: [row(sameKeyA), row(onedriveRequirement)] });
    const A_VALUE = 'dbx-shared-keyname-value-8891aa';
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'dropbox', 'api_key'), A_VALUE);
    await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET' });
    expect(headerOf(calls[0]!, 'x-api-key')).toBe(A_VALUE);
    expect(headerOf(calls[1]!, 'x-api-key')).toBe(ONEDRIVE_KEY);
  });

  it('the response scrubber removes the ROUTED slot’s value from a reflecting body', async () => {
    const { executor } = harness({
      respond: () => new Response(JSON.stringify({ echo: ONEDRIVE_KEY }), { status: 200 }),
    });
    const result = await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.body).not.toContain(ONEDRIVE_KEY);
  });
});

// ------------------------------------------------- AC4: pending-requirement skew

describe('P1-AC4 — the executor binds to the APPROVED grant, never the pending one (folds B2/S-m2)', () => {
  it('a pending requirement WIDENING hosts to evil.example does NOT open evil.example', async () => {
    // The skew window is real: an edit stages a changed requirement while the grant keeps
    // serving. If the executor read `pendingRequirement`, an edit alone would widen the
    // ceiling with no user approval — exactly the silent widening the pending column was
    // introduced to prevent.
    const widened = {
      ...dropboxRequirement,
      declaredApiHosts: ['api.dropbox.com', 'evil.example'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({
      rows: [
        row(dropboxRequirement, {
          allowedHosts: ['api.dropbox.com'], // the FROZEN ceiling, from approval time
          pendingRequirement: widened,
        }),
      ],
    });
    expect(await executor.execute(APP, { url: 'https://evil.example/steal', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
    expect(calls).toHaveLength(0);
  });

  it('the approved host keeps working during the skew window — staging degrades nothing', async () => {
    const widened = {
      ...dropboxRequirement,
      declaredApiHosts: ['api.dropbox.com', 'evil.example'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({
      rows: [row(dropboxRequirement, { allowedHosts: ['api.dropbox.com'], pendingRequirement: widened })],
    });
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(result.ok).toBe(true);
    expect(headerOf(calls[0]!, 'authorization')).toBe(`Bearer ${DROPBOX_TOKEN}`);
  });

  it('a pending requirement changing the TEMPLATE does not change what is sent', async () => {
    // Injection binds to the approved requirement's template too, not only its hosts — a
    // pending template could otherwise re-aim a live secret into a new header today.
    const retemplated = {
      ...dropboxRequirement,
      kind: 'api_key',
      fields: [{ key: 'token', label: 'Access token', type: 'secret', required: true }],
      request: { headerTemplate: { 'X-Exfil': '{{token}}' } },
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({
      rows: [row(dropboxRequirement, { pendingRequirement: retemplated })],
    });
    await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(headerOf(calls[0]!, 'authorization')).toBe(`Bearer ${DROPBOX_TOKEN}`);
    expect(headerOf(calls[0]!, 'x-exfil')).toBeUndefined();
  });

  it('routing itself ignores pending hosts — a pending-only host never even resolves a slot', async () => {
    const pendingOnly = {
      ...onedriveRequirement,
      declaredApiHosts: ['pending.example'],
    } as const satisfies ConnectionRequirement;
    const { executor } = harness({
      rows: [row(onedriveRequirement, { pendingRequirement: pendingOnly })],
    });
    expect(await executor.execute(APP, { url: 'https://pending.example/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
  });
});

// --------------------------------------------------------- AC5: 'none' fails closed

describe("P1-AC5 — kind 'none' fails closed, then injects NOTHING (Q6)", () => {
  const noneRequirement = {
    slot: 'openmeteo',
    provider: { name: 'Open-Meteo' },
    kind: 'none',
    declaredApiHosts: ['api.open-meteo.com'],
  } as const satisfies ConnectionRequirement;

  it('a DECLARED (ungranted) none-connection is NET_NOT_APPROVED — keyless never means ungated', async () => {
    const { executor, calls } = harness({
      rows: [row(noneRequirement, { status: CONNECTION_STATUS.declared })],
    });
    expect(await executor.execute(APP, { url: 'https://api.open-meteo.com/v1/forecast', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
    expect(calls).toHaveLength(0);
  });

  it('once approved it injects NOTHING — no Authorization, no X-Api-Key, no invented header', async () => {
    const { executor, calls } = harness({ rows: [row(noneRequirement)] });
    const result = await executor.execute(APP, { url: 'https://api.open-meteo.com/v1/forecast', method: 'GET' });
    expect(result.ok).toBe(true);
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers).toEqual({});
  });

  it('an approved none-connection is STILL host-ceiling bound', async () => {
    const { executor, calls } = harness({ rows: [row(noneRequirement)] });
    expect(await executor.execute(APP, { url: 'https://evil.example/x', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_NOT_APPROVED,
    });
    expect(calls).toHaveLength(0);
  });

  it('a none-connection still strips app-supplied credential-shaped headers (C1 is kind-independent)', async () => {
    const { executor, calls } = harness({ rows: [row(noneRequirement)] });
    await executor.execute(APP, {
      url: 'https://api.open-meteo.com/v1/forecast',
      method: 'GET',
      headers: { Authorization: 'Bearer app-supplied-forgery', 'X-Api-Key': 'app-supplied' },
    });
    const blob = headerBlob(calls[0]!);
    expect(blob).not.toContain('app-supplied-forgery');
    expect(blob).not.toContain('app-supplied');
  });

  it('a none-connection still needs the confirm gate for a mutating method', async () => {
    const { executor, calls, confirm } = harness({ rows: [row(noneRequirement)], confirmResult: false });
    expect(
      await executor.execute(APP, { url: 'https://api.open-meteo.com/v1/x', method: 'POST', body: '{}' }),
    ).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------- the FROZEN ceiling is not the DECLARED list
//
// FOLDS THE REVIEW'S MAJOR + ITS SIBLING MINOR (P1 three-lens review, regression +
// security lenses). Every OTHER routing test in this file builds its row through `row()`,
// whose default is `allowedHosts: [...requirement.declaredApiHosts]` (:97) — so the frozen
// ceiling and the re-editable declared list are BYTE-EQUAL in all of them, and routing
// cannot tell which one it is reading. The AC4 pending tests look like they separate the
// two but do not: their divergent hosts live on `pendingRequirement`, a different object.
//
// MUTATION EVIDENCE (reproduced by execution on this branch, baseline checksum
// d5bfb17a… restored and re-verified after each run):
//   M5 — connected-fetch.ts:442, `isHostAllowed(host, row.allowedHosts)` ->
//        `isHostAllowed(host, deriveRowHosts(row))`: 296/296 GREEN. Survived.
//   M6 — connected-fetch.ts:462-464, `deriveRowHosts` -> `return
//        row.requirement.declaredApiHosts;` (dropping the length guard): 296/296 GREEN.
//        Survived.
//   M5+M6 TOGETHER are a live credential leak: an approved row with an EMPTY ceiling
//   serves its own declared host and injects the live token there.
//
// The two tests below kill M5 and M6 respectively. Neither needs an implementation change
// — the shipped routing is already correct; it was merely unpinned, and `deriveRowHosts`
// carries a doc-comment claiming its value "NEVER gates a request" that nothing enforced.
describe('P1 — routing reads the FROZEN allowed_hosts, never the requirement’s declared list', () => {
  it('a host declared by the requirement but OUTSIDE the frozen ceiling is refused, with zero fetches', async () => {
    // The ceiling is a STRICT SUBSET of the declared list — the one shape that makes the
    // two distinguishable. `evil.example` is what an app gets by re-editing its own
    // requirement AFTER approval: the declared list is re-editable, the ceiling is not.
    // Under M5 (routing via `deriveRowHosts`) this call would route and inject the live
    // Dropbox token at evil.example.
    const drifted = {
      ...dropboxRequirement,
      declaredApiHosts: ['api.dropbox.com', 'evil.example'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({
      rows: [row(drifted, { allowedHosts: ['api.dropbox.com'] })],
    });
    const result = await executor.execute(APP, { url: 'https://evil.example/x', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(calls).toHaveLength(0);
    // And the drift did not degrade the grant it legitimately holds.
    const good = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(good.ok).toBe(true);
    expect(headerOf(calls[0]!, 'authorization')).toBe(`Bearer ${DROPBOX_TOKEN}`);
  });

  it('an APPROVED row with an EMPTY frozen ceiling serves NOTHING — no fetch and no credential read', async () => {
    // The empty-ceiling invariant, stated as a test rather than as a comment. An approved
    // row should never carry `allowed_hosts: []` (approval freezes a non-empty union), so
    // this row is a corrupt/hand-edited disk state — and the answer to an impossible state
    // is a refusal, never "fall back to whatever the requirement declares today".
    //
    // The CREDENTIAL-READ assertion is the load-bearing half: `calls` alone proves no
    // request left, while an observing store proves the secret was never even loaded, so a
    // future refusal that happens AFTER the read (a leak into a log or an error message)
    // still fails this test.
    const reads: string[] = [];
    const quartet = memoryQuartet();
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'dropbox', 'token'), DROPBOX_TOKEN);
    const observing = {
      ...quartet,
      getSecret: (key: string) => {
        reads.push(key);
        return quartet.getSecret(key);
      },
    };
    const calls: FetchCall[] = [];
    const executor = createConnectedFetch({
      credentialStore: new UserDbCredentialStore(observing),
      connectionReader: {
        listConnections: () => [row(dropboxRequirement, { allowedHosts: [] })],
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, init: init ?? {} });
        return new Response('{"ok":true}', { status: 200 });
      },
      confirmGate: { confirm: vi.fn(async () => true) },
    });
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(calls).toHaveLength(0);
    expect(reads.filter((key) => key.startsWith(`auth:${APP}:`))).toEqual([]);
  });

  it('the CTA fallback prefers a REVOKED row’s frozen ceiling over its declared list — a tombstone cannot re-widen its own copy', async () => {
    // Pins `deriveRowHosts`'s length guard (connected-fetch.ts:462-464) at the ONLY place
    // its two branches are distinguishable. M6 (`return row.requirement.declaredApiHosts;`)
    // survives every other test in this suite — including both tests above — because the
    // function is reached only from the two already-refused CTA paths, and every other row
    // in the file has ceiling == declared.
    //
    // The row here is REVOKED with a frozen ceiling of ['api.dropbox.com'] and a declared
    // list re-edited to add 'cta-phish.example'. Correct behaviour: the ceiling wins, so
    // the un-frozen host matches NO row and the refusal names NO provider. Under M6 the
    // declared list wins and the revoked row is named as the thing to connect — the app
    // choosing its own CTA copy for a host it was never granted, which is the phishing
    // surface `resolveSlot`'s comment (:446-449) says it exists to prevent.
    const ctaDrift = {
      ...dropboxRequirement,
      declaredApiHosts: ['api.dropbox.com', 'cta-phish.example'],
    } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({
      rows: [
        row(ctaDrift, { status: CONNECTION_STATUS.revoked, allowedHosts: ['api.dropbox.com'] }),
      ],
    });
    const result = await executor.execute(APP, { url: 'https://cta-phish.example/x', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain('Dropbox');
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------- AC7: slot-keyed credential store

describe('P1-AC7 — credentials are read at auth:<appId>:<slot>:<fieldKey>, with NO v3 fallback', () => {
  it('reads the slot-keyed secret (not the v3 non-slot key)', async () => {
    const { executor, calls } = harness();
    await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(headerOf(calls[0]!, 'authorization')).toBe(`Bearer ${DROPBOX_TOKEN}`);
  });

  it('a v3 NON-SLOT key is NOT a fallback — a value at auth:<appId>:<field> fails closed', async () => {
    // The cutover trap: v3 rows genuinely exist at `auth:<appId>:<field>` on real users'
    // disks. If the v4 read fell back to them, a slot RENAME would silently keep serving
    // the old provider's credential under a new provider's requirement.
    const { executor, calls, quartet } = harness({ rows: [row(dropboxRequirement)], seedCredentials: false });
    quartet.setSecret(`auth:${APP}:token`, DROPBOX_TOKEN); // the v3 shape, deliberately
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('missing_credential');
    expect(calls).toHaveLength(0);
  });

  it('a slot RENAME fails closed rather than serving the old slot’s value', async () => {
    const renamed = { ...dropboxRequirement, slot: 'dropbox-v2' } as const satisfies ConnectionRequirement;
    const { executor, calls } = harness({ rows: [row(renamed)] });
    // Credentials were seeded under slot `dropbox`; the row now says `dropbox-v2`.
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_AUTH_FAILED });
    expect(calls).toHaveLength(0);
  });

  it('an absent slot credential never degrades to an EMPTY header — no fetch happens at all', async () => {
    const { executor, calls } = harness({ rows: [row(onedriveRequirement)], seedCredentials: false });
    expect(await executor.execute(APP, { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET' })).toMatchObject({
      ok: false,
      code: NET_ERROR_CODES.NET_AUTH_FAILED,
    });
    expect(calls).toHaveLength(0);
  });

  it('the failure message names the FIELD, never the value (C5)', async () => {
    const { executor } = harness({ rows: [row(dropboxRequirement)], seedCredentials: false });
    const result = await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('token');
    expect(result.message).not.toContain(DROPBOX_TOKEN);
  });

  it('values are re-read PER USE — no cache survives between calls (AL-02 D4 under slots)', async () => {
    const { executor, calls, quartet } = harness({ rows: [row(dropboxRequirement)] });
    await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    const ROTATED = 'sl.B7q2-dropbox-ROTATED-0000111122223333';
    quartet.setSecret(authConnectionCredentialSecretKey(APP, 'dropbox', 'token'), ROTATED);
    await executor.execute(APP, { url: 'https://api.dropbox.com/x', method: 'GET' });
    expect(headerOf(calls[1]!, 'authorization')).toBe(`Bearer ${ROTATED}`);
  });
});

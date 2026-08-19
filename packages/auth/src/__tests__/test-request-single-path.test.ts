// TASK-20260810-p1-runtime AC6 (Q7): the `testRequest` probe reaches the network ONLY
// through the 10-gate connected-fetch executor.
//
// WHY THIS FILE EXISTS AT ALL. Q7 admits a "test this connection" button on the wizard's
// done screen, and the obvious implementation of a test button is a small dedicated fetch
// — which is precisely the failure mode the whole executor exists to prevent. A second
// network path would be a second host channel (no frozen-ceiling check), a second
// injection seat (no scrub on the way back), and a second confirm bypass, all reachable
// from a surface whose entire purpose is to be clicked while credentials are fresh. The
// parent plan states the obligation directly: "the probe must not become a second network
// path around the 10 gates."
//
// TWO INDEPENDENT PROOFS, deliberately, because either alone is weak. The BEHAVIOURAL
// test proves the probe honors the gates for the cases we thought to write; the SOURCE
// proof proves no OTHER path exists for the cases we did not — a `fetch(` that never runs
// in a test still ships to a user.
//
// THE INDEPENDENCE CLAIM IS EARNED, NOT ASSUMED, and it was not always true here. The P1
// three-lens review defeated the original delegation assertion by execution: a probe
// rewritten to call `deps.fetchImpl` directly, bypassing all ten gates, left the whole
// SOURCE PROOF block green. That assertion now carries a NEGATIVE half (no `deps.fetchImpl(`
// inside the probe body) which fails against that bypass — see its comment for the full
// mutation. Treat any future source assertion here the same way: if you cannot describe the
// edit it would catch, it is co-occurrence and the behavioural block is carrying it alone.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import {
  CONNECTION_STATUS,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';
import { describe, expect, it, vi } from 'vitest';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';
import {
  createConnectedFetch,
  executeConnectionTestRequest,
  type NetConnectionRow,
} from '../connected-fetch.js';
import { UserDbCredentialStore } from '../credential-store.js';

const APP = 'app-probe';
const KEY_VALUE = 'probe-key-7c21b4e05d68a1f2c3b4d5e6f708';

const probeRequirement = {
  slot: 'openweather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.openweathermap.org'],
  testRequest: { method: 'GET', pathAndQuery: '/data/2.5/weather?q=London' },
} as const satisfies ConnectionRequirement;

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

function harness(opts: { status?: NetConnectionRow['status']; respond?: () => Response } = {}): {
  probe: typeof executeConnectionTestRequest;
  deps: Parameters<typeof executeConnectionTestRequest>[0];
  calls: Array<{ url: string; init: RequestInit }>;
  confirm: ReturnType<typeof vi.fn>;
} {
  const quartet = memoryQuartet();
  quartet.setSecret(authConnectionCredentialSecretKey(APP, 'openweather', 'api_key'), KEY_VALUE);
  const rows: NetConnectionRow[] = [
    {
      appId: APP,
      slot: probeRequirement.slot,
      requirement: probeRequirement,
      status: opts.status ?? CONNECTION_STATUS.approved,
      allowedHosts: ['api.openweathermap.org'],
    },
  ];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const confirm = vi.fn(async () => true);
  const deps = {
    credentialStore: new UserDbCredentialStore(quartet),
    connectionReader: { listConnections: (appId: string) => (appId === APP ? rows : []) },
    fetchImpl: async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return (opts.respond ?? (() => new Response('{"ok":true}', { status: 200 })))();
    },
    confirmGate: { confirm },
  };
  return { probe: executeConnectionTestRequest, deps, calls, confirm };
}

describe('P1-AC6 — testRequest runs THROUGH the executor, never around it', () => {
  it('the probe issues exactly one gated request to the frozen host, with the slot’s credential injected', async () => {
    const { probe, deps, calls } = harness();
    const result = await probe(deps, APP, probeRequirement.slot);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openweathermap.org/data/2.5/weather?q=London');
    const headers = (calls[0]!.init.headers ?? {}) as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(KEY_VALUE);
  });

  it('the probe obeys the APPROVAL gate — an unapproved connection cannot be "tested" into the network', async () => {
    // The sharpest form of the second-path risk: a probe that skipped gate 3 would let a
    // never-approved requirement make a live call with credentials the wizard just took.
    const { probe, deps, calls } = harness({ status: CONNECTION_STATUS.declared });
    const result = await probe(deps, APP, probeRequirement.slot);
    expect(result).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_NOT_APPROVED });
    expect(calls).toHaveLength(0);
  });

  it('the probe cannot leave the frozen ceiling even if the stored path tries to (path-only by construction)', async () => {
    // `pathAndQuery` is path-only in the schema, so a protocol-relative string is the
    // realistic escape attempt: `//evil.example/x` resolves to a NEW HOST under naive
    // concatenation-then-parse.
    const escaping = {
      ...probeRequirement,
      testRequest: { method: 'GET', pathAndQuery: '//evil.example/x' },
    } as unknown as ConnectionRequirement;
    const { deps, calls } = harness();
    (deps.connectionReader as { listConnections: (appId: string) => NetConnectionRow[] }).listConnections = () => [
      {
        appId: APP,
        slot: escaping.slot,
        requirement: escaping,
        status: CONNECTION_STATUS.approved,
        allowedHosts: ['api.openweathermap.org'],
      },
    ];
    const result = await executeConnectionTestRequest(deps, APP, escaping.slot);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect([NET_ERROR_CODES.NET_HOST_BLOCKED, NET_ERROR_CODES.NET_NOT_APPROVED, NET_ERROR_CODES.NET_INVALID_REQUEST]).toContain(
      result.code,
    );
    expect(calls).toHaveLength(0);
  });

  it('the probe’s response is SCRUBBED like any other — a reflecting test endpoint leaks nothing', async () => {
    const { probe, deps } = harness({
      respond: () => new Response(JSON.stringify({ youSent: KEY_VALUE }), { status: 200 }),
    });
    const result = await probe(deps, APP, probeRequirement.slot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.body).not.toContain(KEY_VALUE);
  });

  it('a connection with NO testRequest cannot be probed — nothing is invented', async () => {
    const { deps, calls } = harness();
    (deps.connectionReader as { listConnections: (appId: string) => NetConnectionRow[] }).listConnections = () => [
      {
        appId: APP,
        slot: probeRequirement.slot,
        // Same requirement minus the probe seat.
        requirement: { ...probeRequirement, testRequest: undefined } as unknown as ConnectionRequirement,
        status: CONNECTION_STATUS.approved,
        allowedHosts: ['api.openweathermap.org'],
      },
    ];
    const result = await executeConnectionTestRequest(deps, APP, probeRequirement.slot);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('P1-AC6 — SOURCE PROOF: packages/auth has exactly one seat that calls fetch', () => {
  // The behavioural tests above can only cover the paths we imagined. This walk covers the
  // ones we did not: it fails on a NEW network seat the moment it is added, which is the
  // only way "no second path" stays true after P1 ships.
  const srcDir = join(__dirname, '..');

  function walkSources(): Array<{ name: string; text: string }> {
    const files: Array<{ name: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push({ name: entry.name, text: readFileSync(full, 'utf8') });
      }
    };
    walk(srcDir);
    return files;
  }

  it('no source file calls global fetch — every request goes through an injected fetchImpl', () => {
    // A bare `fetch(` (not `deps.fetch`, not `this.fetch`, not `fetchImpl`) is an
    // un-injectable, un-gated network call by definition: it cannot be observed by a test
    // and cannot be routed through the gates.
    const offenders: string[] = [];
    for (const { name, text } of walkSources()) {
      for (const line of text.split('\n')) {
        const stripped = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/(^|[^.\w])fetch\s*\(/.test(stripped) && !/fetchImpl|globalThis\.fetch\s*=/.test(stripped)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the probe entry point delegates to the executor rather than re-implementing it', () => {
    // STRENGTHENED after the P1 three-lens review (testability lens) demonstrated the old
    // assertion — a bare `expect(probeBody).toContain('execute(')` — was CO-OCCURRENCE, not
    // proof. Mutation, reproduced by execution on this branch: replace the delegation at
    // connected-fetch.ts:886 with a direct `deps.fetchImpl(probeUrl, …)` that skips all ten
    // gates, keeping a dead `const bypassNote = 'execute(';` in scope so the literal still
    // appears in the file text. Under that bypass all THREE tests in this describe block
    // PASSED (verified: only the four behavioural tests in the first block went red), so
    // the file's header claim of "TWO INDEPENDENT PROOFS" did not hold here — this leg was
    // the weak half. The sibling allowlist test below also passed, because the bypass
    // reused the already-allowlisted connected-fetch.ts seat rather than adding a third
    // file. Both assertions below fail against that bypass.
    const text = readFileSync(join(srcDir, 'connected-fetch.ts'), 'utf8');
    const probeIndex = text.indexOf('export async function executeConnectionTestRequest');
    expect(probeIndex, 'executeConnectionTestRequest must live in connected-fetch.ts').toBeGreaterThan(-1);
    const probeBody = text.slice(probeIndex);

    // (1) POSITIVE: the FULL delegation expression, not the bare `execute(` token. A
    // substring that a comment or an unrelated identifier can satisfy proves nothing about
    // where the request goes. MIGRATED (TASK-20260812-desktop-auth-awareness P3): the
    // probe now delegates through `probeDeps` — the SAME deps object with only the
    // `onAuthShapedFailure` observer stripped (ADR-0022 §4 suppression) — so the pin
    // follows the expression AND pins the derivation, so `probeDeps` cannot quietly
    // become a hand-built deps object with a different network seat.
    expect(probeBody).toContain('const { onAuthShapedFailure: _suppressedForProbe, ...probeDeps } = deps;');
    expect(probeBody).toContain('createConnectedFetch(probeDeps).execute(');

    // (2) NEGATIVE, and this is the half that actually catches a bypass: the probe body
    // must hold NO network seat of its own. `deps.fetchImpl(` anywhere after the probe's
    // declaration means the probe reaches the network directly — which is exactly the
    // second path Q7 forbids, and is invisible to (1) because a bypass can keep the
    // delegation line dead-but-present.
    expect(probeBody).not.toContain('deps.fetchImpl(');
    // EXTENDED at P5 (ADR-0023 D3): the LAN pinned transport is a SECOND
    // injected network seat, so the probe must not grow its own copy of that
    // one either. Without this line, a probe rewritten to call
    // `deps.lanFetch(...)` directly would satisfy every assertion above — the
    // exact bypass shape the P1 review found, one transport later.
    expect(probeBody).not.toContain('deps.lanFetch(');
  });

  it('exactly THREE modules hold a network seat, all of them named — a fourth is a test failure', () => {
    const callers = walkSources()
      .filter(({ text }) => /fetchImpl\s*\(/.test(text))
      .map(({ name }) => name)
      .sort();
    // This is an ALLOWLIST, not a claim of singularity, and the distinction is the whole
    // value of the test. `oauth-service.ts` legitimately calls its own injected seam for
    // token exchange — a token mint is not an app request and never carries the app's
    // headers — and `connected-fetch.ts` is the app-request executor that supplies it.
    // Pinning each by NAME means a new network seat (the shape a "test this connection"
    // button naturally grows) fails this test the moment it appears, which is precisely
    // the Q7 obligation. A length assertion would let a new seat replace an old one
    // silently.
    //
    // EXTENDED 2026-08-18 (TASK-20260818-ledger-starter, ADR-0038): `token-claim.ts` is
    // the third seat, and it is oauth-service's class, not a bypass of the executor's —
    // a credential MINT over the same injected seam, running BEFORE any stored
    // credential exists. The executor structurally cannot host it: gate 3 requires an
    // approved row whose credential it INJECTS from the store, while the claim's verify
    // must ride the just-minted, not-yet-stored pair (ADR-0025 verify-before-commit).
    // Its own gates are pinned in token-claim.test.ts (ceiling membership on BOTH URLs,
    // https/port/userinfo refusals, redirect:'error' arriving as an option).
    expect(callers).toEqual(['connected-fetch.ts', 'oauth-service.ts', 'token-claim.ts']);
  });

  /**
   * THE SAME FENCE, MOVED for the new transport (AC9; ADR-0023 D3).
   *
   * `lanFetch` is a second injected network seat and the allowlist above cannot
   * see it — it matches on `fetchImpl(`. A LAN seat added to a third module
   * would therefore be exactly the un-gated second path this file exists to
   * forbid, and every assertion above would stay green.
   *
   * ONE module may hold it, and it is the executor: routing to the pinned
   * transport is a decision about the frozen ceiling (ADR-0023 D3 / P0
   * amendment 6 put it "IN THE EXECUTOR at gates 4/5" for that reason), so any
   * other caller would be routing without the ceiling in hand.
   */
  it('exactly ONE module holds the LAN pinned seat — the executor, where the ceiling is known', () => {
    const lanCallers = walkSources()
      .filter(({ text }) => /lanFetch\s*\(/.test(text))
      .map(({ name }) => name)
      .sort();
    expect(lanCallers).toEqual(['connected-fetch.ts']);
  });

  it('the LAN seat is never a fallback for fetchImpl, in either direction', () => {
    // The two one-line edits that would quietly undo the whole design:
    //   `deps.lanFetch ?? deps.fetchImpl` — sends a bridge request through the
    //     public-root transport, which fails opaquely or succeeds against the
    //     wrong device;
    //   `deps.fetchImpl ?? deps.lanFetch` — sends a PUBLIC request through the
    //     pinned transport, handing relaxed certificate verification to a host
    //     that never earned it.
    // Both read as defensive coding, and neither is.
    const text = readFileSync(join(srcDir, 'connected-fetch.ts'), 'utf8');
    const source = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(source).not.toMatch(/lanFetch\s*\?\?\s*deps?\.?fetchImpl/);
    expect(source).not.toMatch(/fetchImpl\s*\?\?\s*deps?\.?lanFetch/);
  });
});

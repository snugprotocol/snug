// TASK-20261023-siwc-chatgpt-plan L0 (plan §2/§3 L0): the contracts the parallel lanes build
// against — the session file, the Rust-backed store seat, the loopback seat, the keeper's
// API, the error codes — plus the two licence tripwires from D9: OpenAI's DevKit is under a
// Noncommercial licence, so `@siwc/` must never enter the lockfile or a package manifest.
// Type-level assertions run under the package's `tsc -p tsconfig.test.json`; the tripwire
// runs under vitest and is proven able to fail against a planted lockfile.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CHATGPT_PLAN_ERROR_CODES,
  ChatgptPlanError,
  createDesktopOAuthTransport,
  type CallbackDelivery,
  type CallbackErrorDelivery,
  type ChatgptLoopbackSeat,
  type ChatgptModel,
  type ChatgptPlanErrorCode,
  type ChatgptPlanSession,
  type ChatgptPlanStatus,
  type ChatgptSessionFile,
  type ChatgptSessionStore,
  type LoopbackListener,
} from '../index.js';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** The tripwire's pure core: the first `@siwc/<name>` scope reference in `text`, or undefined. */
function findForbiddenSiwcDependency(text: string): string | undefined {
  return /@siwc\/[A-Za-z0-9._-]+/.exec(text)?.[0];
}

describe('L0 — error codes (§2): the keeper names every failure', () => {
  it('pins the eleven codes', () => {
    expect([...CHATGPT_PLAN_ERROR_CODES].sort()).toEqual(
      [
        'sign_in_needed',
        'plan_not_granted',
        'usage_limit',
        'usage_unavailable',
        'client_mismatch',
        'registration_incomplete',
        'id_token_invalid',
        'subject_mismatch',
        'refresh_not_ready',
        'revocation_unconfirmed',
        'network',
      ].sort(),
    );
    expectTypeOf<ChatgptPlanErrorCode>().toEqualTypeOf<(typeof CHATGPT_PLAN_ERROR_CODES)[number]>();
  });

  it('ChatgptPlanError carries a code and a retryable flag (errors a caller can act on by name)', () => {
    const err = new ChatgptPlanError('sign in to ChatGPT to continue', 'sign_in_needed');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatgptPlanError');
    expect(err.code).toBe('sign_in_needed');
    expect(err.retryable).toBe(false);
    expect(new ChatgptPlanError('try again', 'network', true).retryable).toBe(true);
  });
});

describe('L0 — the session file and the store seat (D2)', () => {
  it('a v1 file type-checks with and without tokens; `planGranted` is required (a grant without the scope is a named state)', () => {
    const registeredOnly: ChatgptSessionFile = { v: 1, hostId: 'urn:uuid:4f5d…', clientId: 'oaiapp_abc', planGranted: false };
    const signedIn: ChatgptSessionFile = {
      v: 1,
      hostId: 'urn:uuid:4f5d…',
      clientId: 'oaiapp_abc',
      tokens: {
        accessToken: 'eyJ.a.b',
        refreshToken: 'rt-1',
        idToken: 'eyJ.c.d',
        expiresAt: 1_800_000_000_000,
        earliestRefreshAt: 1_799_999_000_000,
        scopes: ['openid', 'chatgpt.tokens.use.direct'],
      },
      account: { sub: 'user-1', email: 'a@b.c', name: 'A' },
      planGranted: true,
      models: { fetchedAt: 1, list: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] },
    };
    expect(registeredOnly.tokens).toBeUndefined();
    expect(signedIn.tokens?.scopes).toContain('chatgpt.tokens.use.direct');
    // @ts-expect-error — the version is literal 1, never a free number
    const wrong: ChatgptSessionFile = { v: 2, hostId: 'x', planGranted: false };
    expect(wrong.v).toBe(2);
  });

  it('a model carries OpenAI’s own vocabulary — id, display name, the levels THAT model has (ADR-0070)', () => {
    expectTypeOf<ChatgptModel>().toEqualTypeOf<{ id: string; name: string; efforts: readonly string[]; defaultEffort?: string }>();
  });

  it('the store seat is read / write / clear over the whole file — no partial writes, no field-level API', () => {
    expectTypeOf<ChatgptSessionStore>().toEqualTypeOf<{
      read(): Promise<ChatgptSessionFile | undefined>;
      write(file: ChatgptSessionFile): Promise<void>;
      clear(): Promise<void>;
    }>();
  });
});

describe('L0 — the loopback contract (D10)', () => {
  it('CallbackDelivery gained an optional clientId; CallbackErrorDelivery carries error + state and never a code', () => {
    const first: CallbackDelivery = { appId: 'chatgpt-plan', flowId: 'f1', code: 'c', state: 's', clientId: 'oaiapp_abc' };
    const reauth: CallbackDelivery = { appId: 'chatgpt-plan', flowId: 'f1', code: 'c', state: 's' };
    expect(first.clientId).toBe('oaiapp_abc');
    expect(reauth.clientId).toBeUndefined();
    const declined: CallbackErrorDelivery = { appId: 'chatgpt-plan', flowId: 'f1', state: 's', error: 'access_denied', errorDescription: 'The user declined' };
    expect(declined.error).toBe('access_denied');
    expectTypeOf<CallbackErrorDelivery>().not.toHaveProperty('code');
  });

  it('the transport deps accept an opt-in onError and beginFlow accepts a path (behaviour lands in L1)', () => {
    const listener: LoopbackListener = { start: async () => ({ port: 49152, stop: async () => undefined }) };
    const transport = createDesktopOAuthTransport({ listener, onDelivery: () => undefined, onError: () => undefined });
    expectTypeOf(transport.beginFlow).parameter(0).toMatchTypeOf<{ posture: 'loopback' | 'loopback-fixed-port'; appId: string; path?: string }>();
  });

  it('the seat the shell implements: begin(path) → redirectUri, onCallback(code OR error) → unsubscribe, cancel()', () => {
    expectTypeOf<ChatgptLoopbackSeat>().toEqualTypeOf<{
      begin(path: string): Promise<{ redirectUri: string }>;
      onCallback(cb: (d: CallbackDelivery | CallbackErrorDelivery) => void): () => void;
      cancel(): Promise<void>;
    }>();
  });
});

describe('L0 — the keeper’s API (§2) and status (D5)', () => {
  it('status is unknown (WAIT — F9), signed out with registration truth, or signed in with the plan flag', () => {
    const waiting: ChatgptPlanStatus = 'unknown';
    const out: ChatgptPlanStatus = { signedIn: false, registered: true };
    const ready: ChatgptPlanStatus = { signedIn: true, planGranted: true, email: 'a@b.c', models: [] };
    const limited: ChatgptPlanStatus = { signedIn: true, planGranted: true, models: [], limit: { at: 1, code: 'usage_limit' } };
    expect([waiting, out, ready, limited]).toHaveLength(4);
    // @ts-expect-error — a signed-out status has no plan flag to lie with
    const bad: ChatgptPlanStatus = { signedIn: false, planGranted: true };
    expect(bad).toBeDefined();
  });

  it('the session surface: signIn / cancelSignIn / signOut / forgetRegistration / getAccessToken / refreshNow / status / subscribe / listModels', () => {
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('signIn');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('cancelSignIn');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('signOut');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('forgetRegistration');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('getAccessToken');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('refreshNow');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('status');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('subscribe');
    expectTypeOf<ChatgptPlanSession>().toHaveProperty('listModels');
    expectTypeOf<ChatgptPlanSession['getAccessToken']>().returns.resolves.toEqualTypeOf<string>();
    expectTypeOf<ChatgptPlanSession['signOut']>().returns.resolves.toEqualTypeOf<{ revocation: 'confirmed' | 'unconfirmed' | 'none' }>();
  });
});

describe('L0 — licence tripwires (D9, S15): nothing from OpenAI’s Noncommercial DevKit', () => {
  it('the pure check names an `@siwc/` dependency wherever it appears', () => {
    expect(findForbiddenSiwcDependency("packages:\n  '@siwc/local@0.3.0':\n    resolution: …")).toBe('@siwc/local');
    expect(findForbiddenSiwcDependency('"@siwc/react": "^1.0.0"')).toBe('@siwc/react');
    expect(findForbiddenSiwcDependency('')).toBeUndefined();
    expect(findForbiddenSiwcDependency("packages:\n  '@tauri-apps/api@2.0.0':")).toBeUndefined();
    // A word that merely contains the letters is not the scope.
    expect(findForbiddenSiwcDependency('the siwc track, @siwcx/other')).toBeUndefined();
  });

  it('pnpm-lock.yaml carries no `@siwc/` package', () => {
    const lock = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
    expect(lock.length).toBeGreaterThan(1000);
    expect(findForbiddenSiwcDependency(lock)).toBeUndefined();
  });

  it('the two packages this task extends declare no `@siwc/` dependency', () => {
    for (const pkg of ['packages/auth/package.json', 'packages/adapters/package.json']) {
      expect(findForbiddenSiwcDependency(readFileSync(join(REPO_ROOT, pkg), 'utf8')), pkg).toBeUndefined();
    }
  });
});

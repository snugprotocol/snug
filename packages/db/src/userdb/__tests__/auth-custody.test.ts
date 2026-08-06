// AL-02 (TASK-20260805-auth-core) AC2: the custody line of ADR-0014 / plan D3, proven
// with BYTE-PROBES (never API asserts) across all four paths:
//   (i)  hub push carries no `auth:` bytes (secretsAllowed:false wins over any opt-in)
//   (ii) default export carries no `auth:` bytes
//   (iii) Dropbox-style personal push DOES carry them — only under BOTH gates
//        (provider secretsAllowed AND embedder includeSecrets) — by design
//   (iv) full export opt-in carries them
// Plus the D5/N3 state-placement invariant (a connection-state write never dirties the
// synced snug_auth_specs surface) and the AL-04 forward-constraint CANARY (finding 14):
// credential values never appear in chat rows of an exported file.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { createSyncLoop } from '../../sync/loop.js';
import { sha256Hex } from '../../sync/sidecar.js';
import type { SyncProvider, SyncPushResult } from '../../sync/provider.js';
import {
  AUTH_STATE_HMAC_SECRET_KEY,
  authConnectionSecretKey,
  authCredentialSecretKey,
} from '../auth-secrets.js';
import { openUserDb, type UserDb } from '../userdb.js';

const SENTINEL = 'SENTINEL-AUTH-VALUE-7f3a9c1e-never-in-clear';

const open = async (backend: MemoryBackend): Promise<UserDb> => {
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

/** Raw byte probe: does `haystack` contain the UTF-8 bytes of `needle`? */
function bytesContain(haystack: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + target.length <= haystack.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** A capturing byte-store provider — the loop sees exactly what an origin would receive. */
function capturingProvider(kind: string, secretsAllowed: boolean): SyncProvider & { pushed: Uint8Array[] } {
  const pushed: Uint8Array[] = [];
  return {
    pushed,
    info: () => ({ kind, secretsAllowed }),
    pull: () => Promise.resolve(undefined),
    push: (bytes): Promise<SyncPushResult> => {
      pushed.push(bytes);
      return Promise.resolve({ ok: true, revision: `r${pushed.length}` });
    },
  };
}

let backend: MemoryBackend;
let db: UserDb;
const APP = 'app-under-test';

beforeEach(async () => {
  backend = createMemoryBackend();
  db = await open(backend);
  db.setSecret(authCredentialSecretKey(APP, 'access_token'), SENTINEL);
  db.setSecret(AUTH_STATE_HMAC_SECRET_KEY, `hmac-${SENTINEL}`);
});

describe('AC2 — custody-line byte probes (ADR-0014 / plan D3)', () => {
  it('custody-line.hub-push-carries-no-auth-bytes — even when the embedder asks for secrets', async () => {
    const provider = capturingProvider('hub', false);
    const loop = createSyncLoop({ userDb: db, provider, backend, includeSecrets: true });
    await loop.syncNow();
    expect(provider.pushed).toHaveLength(1);
    expect(bytesContain(provider.pushed[0]!, SENTINEL)).toBe(false);
    await db.close();
  });

  it('custody-line.default-export-carries-no-auth-bytes', async () => {
    const bytes = await db.exportUserDb();
    expect(bytesContain(bytes, SENTINEL)).toBe(false);
    await db.close();
  });

  it('custody-line.dropbox-carries-secrets-by-design — BOTH gates required, and then the full file travels', async () => {
    // Gate check: provider allows secrets but the embedder has not opted in → stripped.
    const withoutOptIn = capturingProvider('dropbox', true);
    const gated = createSyncLoop({ userDb: db, provider: withoutOptIn, backend });
    await gated.syncNow();
    expect(bytesContain(withoutOptIn.pushed[0]!, SENTINEL)).toBe(false);

    // Both gates open: the user's own storage carries the FULL file including auth:
    // values — deliberate, opt-in, the cross-device story (ADR-0014 clause 2).
    const provider = capturingProvider('dropbox', true);
    const loop = createSyncLoop({ userDb: db, provider, backend, includeSecrets: true });
    await loop.syncNow();
    expect(bytesContain(provider.pushed[0]!, SENTINEL)).toBe(true);
    await db.close();
  });

  it('custody-line.full-export-opt-in-carries-auth-bytes', async () => {
    const bytes = await db.exportUserDb({ includeSecrets: true });
    expect(bytesContain(bytes, SENTINEL)).toBe(true);
    await db.close();
  });

  it('the state HMAC key (auth:_state_hmac) is absent from default-export bytes (finding 11)', async () => {
    const bytes = await db.exportUserDb();
    expect(bytesContain(bytes, `hmac-${SENTINEL}`)).toBe(false);
    expect(bytesContain(bytes, AUTH_STATE_HMAC_SECRET_KEY)).toBe(false);
    await db.close();
  });
});

describe('AC3/N3 — dynamic state never dirties the synced spec surface', () => {
  it('a connection-state write leaves the snug_auth_specs content of the default export unchanged', async () => {
    db.putAuthSpec(APP, {
      kind: 'bearer_token',
      provider: { name: 'GitHub' },
      fields: [{ key: 'token', label: 'PAT', type: 'secret' }],
      declaredApiHosts: ['api.github.com'],
    });
    db.approveAuthSpec(APP);
    const before = await db.exportUserDb();

    // What a token refresh persists: dynamic connection state + rotated token — all
    // under auth: secret keys (plan N3), never in snug_auth_specs.
    db.setSecret(
      authConnectionSecretKey(APP),
      JSON.stringify({ status: 'connected', obtained_at: Date.now(), expires_in: 3600 }),
    );
    db.setSecret(authCredentialSecretKey(APP, 'access_token'), `${SENTINEL}-rotated`);

    const after = await db.exportUserDb();
    // The synced SPEC SURFACE must be untouched: identical snug_auth_specs content in
    // both exports. (Whole-file byte identity is unattainable — SQLite's header change
    // counter moves on ANY transaction, including the stripped secret writes.)
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const dumpSpecs = (bytes: Uint8Array): string => {
      const opened = new SQL.Database(bytes);
      try {
        return JSON.stringify(opened.exec('SELECT * FROM snug_auth_specs ORDER BY app_id'));
      } finally {
        opened.close();
      }
    };
    expect(dumpSpecs(after)).toBe(dumpSpecs(before));
    // And no dynamic-state bytes leak into the synced default export at all.
    expect(bytesContain(after, '_connection')).toBe(false);
    expect(bytesContain(after, `${SENTINEL}-rotated`)).toBe(false);
    await db.close();
  });
});

describe('canary — credential values never reach chat rows (AL-04 forward constraint, finding 14)', () => {
  const simulatePostWizardChat = (): void => {
    db.upsertThread('wizard-thread', { appId: APP, title: 'Connect Spotify' });
    db.appendChatMessage('wizard-thread', 'user', 'connect my spotify please');
    db.appendChatMessage('wizard-thread', 'assistant', 'Connected! Tokens are stored locally.', {
      meta: { card: 'auth-connected', appId: APP },
    });
  };

  it('canary.credential-value-never-in-chat-export — full-export chat tables carry no secret value', async () => {
    simulatePostWizardChat();
    await db.flush();
    // Full export DOES carry snug_secrets (that is custody, path iv) — so probe the CHAT
    // surface specifically: every chat row of the exported file, every field incl. meta.
    const bytes = await db.exportUserDb({ includeSecrets: true });
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const exported = new SQL.Database(bytes);
    try {
      const rows = exported.exec('SELECT thread_id, role, content, meta FROM snug_chat_messages')[0]?.values ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(JSON.stringify(row)).not.toContain(SENTINEL);
      }
      // And the default export (no secrets table at all) must not carry it anywhere.
      expect(bytesContain(await db.exportUserDb(), SENTINEL)).toBe(false);
    } finally {
      exported.close();
    }
    await db.close();
  });

  it('canary.probe-detects-planted-secret — the probe CAN go red (mutation self-check)', async () => {
    simulatePostWizardChat();
    // Deliberately commit the defect the canary guards against: a secret value written
    // into chat meta. The probe MUST find it — proving the assertion above is live.
    db.appendChatMessage('wizard-thread', 'assistant', 'debug', { meta: { leaked: SENTINEL } });
    await db.flush();
    const bytes = await db.exportUserDb();
    expect(bytesContain(bytes, SENTINEL)).toBe(true);
    await db.close();
  });
});

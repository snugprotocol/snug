// The CredentialStore seam (AL-02 plan D4): the ONLY reader of `auth:` secret values.
// The OAuth service depends on the INTERFACE; `UserDbCredentialStore` seats it on the
// user DB's secrets quartet (ADR-0014: every credential lives in `snug_secrets` inside
// the user's own file). There is NO long-lived plaintext token cache anywhere —
// values are read from the store per use (finding 10; the lifecycle test drives
// connect→use→disconnect and proves no retained copy survives).
import {
  AUTH_CONNECTION_FIELD,
  AUTH_STATE_HMAC_SECRET_KEY,
  authAppSecretPrefix,
  authConnectionSecretKey,
  authCredentialSecretKey,
} from '@snugprotocol/db';
import { randomBase64Url } from './base64url.js';

/**
 * Dynamic connection state (plan N3): lives at secret key `auth:<appId>:_connection` —
 * export-stripped by default, Dropbox-carried under the D3 gates, and NEVER a column
 * of `snug_auth_specs` (a token refresh must not dirty the synced spec surface).
 */
export interface AuthConnectionState {
  status: 'pending' | 'connected' | 'expired' | 'error';
  /** Epoch ms when the current access token was obtained. */
  obtainedAt?: number;
  /** Provider-reported lifetime of the access token, seconds. */
  expiresIn?: number;
  scopesGranted?: string[];
  lastError?: string;
}

/** The secrets quartet — the structural slice of UserDb the store consumes. */
export interface SecretsQuartet {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
}

/**
 * Async-first by design: implementations may sit on async storage; the UserDb-backed
 * one resolves immediately. AL-03's injection runtime and AL-04's wizard consume THIS
 * interface, never the db directly.
 */
export interface CredentialStore {
  getCredential(appId: string, field: string): Promise<string | undefined>;
  setCredential(appId: string, field: string, value: string): Promise<void>;
  deleteCredential(appId: string, field: string): Promise<void>;
  /** Credential field names present for the app (excludes the `_connection` state row). */
  listCredentialFields(appId: string): Promise<string[]>;

  getConnectionState(appId: string): Promise<AuthConnectionState | undefined>;
  setConnectionState(appId: string, state: AuthConnectionState): Promise<void>;
  clearConnectionState(appId: string): Promise<void>;

  /** Wipe the whole `auth:<appId>:*` slice — disconnect's final act. */
  clearApp(appId: string): Promise<void>;

  /**
   * The per-user state-signing HMAC key at `auth:_state_hmac` — generated on first
   * use (32 random bytes, base64url), reused for NOTHING else (finding 11).
   */
  getOrCreateStateHmacKey(): Promise<string>;
}

export class UserDbCredentialStore implements CredentialStore {
  constructor(private readonly db: SecretsQuartet) {}

  getCredential(appId: string, field: string): Promise<string | undefined> {
    return Promise.resolve(this.db.getSecret(authCredentialSecretKey(appId, field)));
  }

  setCredential(appId: string, field: string, value: string): Promise<void> {
    this.db.setSecret(authCredentialSecretKey(appId, field), value);
    return Promise.resolve();
  }

  deleteCredential(appId: string, field: string): Promise<void> {
    this.db.deleteSecret(authCredentialSecretKey(appId, field));
    return Promise.resolve();
  }

  listCredentialFields(appId: string): Promise<string[]> {
    const prefix = authAppSecretPrefix(appId);
    const fields = this.db
      .listSecretKeys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((field) => field !== AUTH_CONNECTION_FIELD);
    return Promise.resolve(fields);
  }

  getConnectionState(appId: string): Promise<AuthConnectionState | undefined> {
    const raw = this.db.getSecret(authConnectionSecretKey(appId));
    if (raw === undefined) return Promise.resolve(undefined);
    try {
      return Promise.resolve(JSON.parse(raw) as AuthConnectionState);
    } catch {
      return Promise.resolve(undefined); // corrupt state reads as absent, never throws
    }
  }

  setConnectionState(appId: string, state: AuthConnectionState): Promise<void> {
    this.db.setSecret(authConnectionSecretKey(appId), JSON.stringify(state));
    return Promise.resolve();
  }

  clearConnectionState(appId: string): Promise<void> {
    this.db.deleteSecret(authConnectionSecretKey(appId));
    return Promise.resolve();
  }

  clearApp(appId: string): Promise<void> {
    const prefix = authAppSecretPrefix(appId);
    for (const key of this.db.listSecretKeys()) {
      if (key.startsWith(prefix)) this.db.deleteSecret(key);
    }
    return Promise.resolve();
  }

  getOrCreateStateHmacKey(): Promise<string> {
    const existing = this.db.getSecret(AUTH_STATE_HMAC_SECRET_KEY);
    if (existing !== undefined && existing.length > 0) return Promise.resolve(existing);
    const key = randomBase64Url(32);
    this.db.setSecret(AUTH_STATE_HMAC_SECRET_KEY, key);
    return Promise.resolve(key);
  }
}

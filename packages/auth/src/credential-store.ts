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
  authConnectionStateSecretKey,
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
  /**
   * THE TOFU CERTIFICATE PIN for a LAN-class connection (ADR-0023 Decision 3;
   * P0 amendment 6). Recorded once, at pairing, by the desktop shell's
   * `lan_fetch` in `mode:'pair'` — whose rustls verifier is the only place the
   * peer certificate is ever visible — and read per request thereafter to drive
   * the same command in `mode:'pinned'`.
   *
   * IT LIVES HERE, in the connection's dynamic-state KV, and NOT as a column of
   * `snug_connections`, because that is precisely what this KV is for
   * (ADR-0014 custody): per-connection state that changes without the
   * REQUIREMENT changing. A column would dirty the synced spec surface on a
   * re-pair and would travel in exports that deliberately strip secrets. The
   * P0 refutation record notes this needs no db schema change for exactly this
   * reason.
   *
   * `fingerprint` is the lowercase-hex SHA-256 of the leaf certificate's DER —
   * the definition is pinned on the Rust side (`fingerprint_der`) and its shape
   * is re-validated here before any request rides it. `cn` is DIAGNOSTIC only
   * (a Hue bridge puts its bridgeId there); it is shown to the user and
   * journaled, and is never a trust input.
   */
  lanPin?: { fingerprint: string; cn?: string };
  /**
   * Epoch ms when the ADR-0025 verify read last PROVED the LAN credential against the
   * pinned device. Written by the wizard's verify step and NOTHING else. Its absence on
   * a `connected` LAN state marks a pre-ADR-0025 claim nothing ever proved — the wizard
   * treats that as pairing still owed, which is what makes the legacy rows (paired
   * under the old instant-claim code) repair themselves honestly on next open instead
   * of needing a data migration.
   */
  lanVerifiedAt?: number;
  /**
   * Epoch ms when the ADR-0025 verify read last PROVED a LINKED-DEVICE credential against
   * the helper (ADR-0032). The `lanVerifiedAt` twin, for the family that has no TLS pin.
   *
   * Its own field rather than a shared one, because the two describe different proofs about
   * different transports: a LAN row's marker says a pinned certificate answered, this one
   * says a unix-socket helper accepted the minted key. Collapsing them would let a stale
   * marker from one family vouch for the other.
   *
   * Written by the wizard's verify step and NOTHING else, and only ever describing the key
   * now in the store. Its absence on a `connected` linked-device row means nothing proved
   * that link, so the wizard treats pairing as still owed — the same self-repair the LAN
   * rows get, rather than a data migration.
   */
  linkVerifiedAt?: number;
  /**
   * Epoch ms when the ADR-0025 verify read last PROVED a TOKEN-CLAIM credential against
   * the provider (ADR-0038). The third member of the verify-marker family, its own
   * field for the family's standing reason: each marker describes a different proof
   * about a different transport, and collapsing them would let a stale marker from one
   * family vouch for another.
   *
   * Written by the claim's write-together commit and NOTHING else. Its presence on a
   * `connected` row is what tells the wizard the claim already ran — re-opening the
   * wizard must never re-claim (a setup token works exactly once).
   */
  claimVerifiedAt?: number;
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

  /**
   * The optional `slot` is the Dynamic Auth v2 (P1) addition: absent it reads v3's
   * `auth:<appId>:_connection`; present it reads v4's `auth:<appId>:<slot>:_connection`.
   * OPTIONAL rather than required because the v3 callers (`snug_auth_specs`) keep shipping
   * until P3 — making it required would break every one of them for a phase they are not
   * part of (cutover rule, fold B1).
   */
  getConnectionState(appId: string, slot?: string): Promise<AuthConnectionState | undefined>;
  setConnectionState(appId: string, state: AuthConnectionState, slot?: string): Promise<void>;
  clearConnectionState(appId: string, slot?: string): Promise<void>;

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

  /** v3 `auth:<appId>:_connection`, or v4 `auth:<appId>:<slot>:_connection` when slotted. */
  private connectionKey(appId: string, slot?: string): string {
    return slot === undefined ? authConnectionSecretKey(appId) : authConnectionStateSecretKey(appId, slot);
  }

  getConnectionState(appId: string, slot?: string): Promise<AuthConnectionState | undefined> {
    const raw = this.db.getSecret(this.connectionKey(appId, slot));
    if (raw === undefined) return Promise.resolve(undefined);
    try {
      return Promise.resolve(JSON.parse(raw) as AuthConnectionState);
    } catch {
      return Promise.resolve(undefined); // corrupt state reads as absent, never throws
    }
  }

  setConnectionState(appId: string, state: AuthConnectionState, slot?: string): Promise<void> {
    this.db.setSecret(this.connectionKey(appId, slot), JSON.stringify(state));
    return Promise.resolve();
  }

  clearConnectionState(appId: string, slot?: string): Promise<void> {
    this.db.deleteSecret(this.connectionKey(appId, slot));
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

// shareLinks.ts — the sharer's link records (AC22, plan-review finding 9).
//
// Two homes by sensitivity. The PUBLIC record `{ id, expiresAt, createdAt }` lives in
// `snug_settings` under `shareLink:<appId>:<id>` (per app → `deleteApp` cascades it).
// The revoke TOKEN and the decryption KEY live in `snug_secrets` under `share:<id>` —
// hub-origin sync pushes and default exports strip `snug_secrets`, so neither ever
// reaches a hub the owner operates, which is what keeps "we can't read what's inside"
// true for a hub-synced sharer. The key is kept at all only so the sharer can copy the
// same link again from the sheet; it is not a credential of the sharer's.

import { shareLinkSettingKey, shareLinkSettingPrefixFor, type UserDb } from '@snugprotocol/db';

import { getUserDb } from '../state/userdb.js';
import { encryptBundle } from './bundleCrypto.js';
import { DEFAULT_SHARE_EXPIRY, revokeShare, shareLinkFor, uploadCiphertext, type ShareExpiry } from './relayClient.js';
import type { PreparedShare } from './exportShare.js';

export const SHARE_SECRET_PREFIX = 'share:';

export interface ShareLinkRecord {
  id: string;
  expiresAt: string;
  createdAt: string;
}

interface ShareSecret {
  revokeToken: string;
  key: string;
}

export function shareSecretKey(id: string): string {
  return `${SHARE_SECRET_PREFIX}${id}`;
}

function readSecret(db: UserDb, id: string): ShareSecret | undefined {
  const raw = db.getSecret(shareSecretKey(id));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ShareSecret>;
    if (typeof parsed.revokeToken !== 'string' || typeof parsed.key !== 'string') return undefined;
    return { revokeToken: parsed.revokeToken, key: parsed.key };
  } catch {
    return undefined;
  }
}

/** Encrypt → upload (for the chosen lifetime) → record. Returns the link to copy or share. */
export async function mintShareLink(
  appId: string,
  prepared: PreparedShare,
  expires: ShareExpiry = DEFAULT_SHARE_EXPIRY,
): Promise<{ link: string; record: ShareLinkRecord }> {
  const sealed = await encryptBundle(new TextEncoder().encode(prepared.text));
  const uploaded = await uploadCiphertext(sealed.ciphertext, expires);
  const db = await getUserDb();
  const record: ShareLinkRecord = { id: uploaded.id, expiresAt: uploaded.expiresAt, createdAt: new Date().toISOString() };
  db.setSecret(shareSecretKey(uploaded.id), JSON.stringify({ revokeToken: uploaded.revokeToken, key: sealed.key } satisfies ShareSecret));
  db.setSetting(shareLinkSettingKey(appId, uploaded.id), record);
  return { link: shareLinkFor(uploaded.id, sealed.key), record };
}

/** The app's active (unexpired) links, newest first. Expired records are pruned on read. */
export function listShareLinks(db: UserDb, appId: string): ShareLinkRecord[] {
  const prefix = shareLinkSettingPrefixFor(appId);
  const out: ShareLinkRecord[] = [];
  const now = Date.now();
  for (const key of db.listSettingKeys()) {
    if (!key.startsWith(prefix)) continue;
    const raw = db.getSetting(key) as Partial<ShareLinkRecord> | undefined;
    if (raw === undefined || typeof raw.id !== 'string' || typeof raw.expiresAt !== 'string') {
      db.deleteSetting(key);
      continue;
    }
    if (Date.parse(raw.expiresAt) <= now) {
      db.deleteSetting(key);
      db.deleteSecret(shareSecretKey(raw.id));
      continue;
    }
    out.push({ id: raw.id, expiresAt: raw.expiresAt, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : raw.expiresAt });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Re-copy an existing link (the key lives in secrets). Undefined when the secret is gone. */
export function linkForRecord(db: UserDb, record: ShareLinkRecord): string | undefined {
  const secret = readSecret(db, record.id);
  return secret === undefined ? undefined : shareLinkFor(record.id, secret.key);
}

/** Revoke at the relay (best-effort) and forget locally either way. */
export async function revokeShareLink(appId: string, id: string): Promise<boolean> {
  const db = await getUserDb();
  const secret = readSecret(db, id);
  let revoked = false;
  if (secret !== undefined) {
    try {
      revoked = await revokeShare(id, secret.revokeToken);
    } catch {
      revoked = false;
    }
  }
  db.deleteSetting(shareLinkSettingKey(appId, id));
  db.deleteSecret(shareSecretKey(id));
  return revoked;
}

/** Every link of one app, revoked at the relay best-effort (used by app delete; the cascade removes the rows). */
export async function revokeShareLinksForApp(db: UserDb, appId: string): Promise<void> {
  for (const record of listShareLinks(db, appId)) {
    const secret = readSecret(db, record.id);
    if (secret === undefined) continue;
    try {
      await revokeShare(record.id, secret.revokeToken);
    } catch {
      /* unreachable relay: the TTL is the backstop */
    }
  }
}

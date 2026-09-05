// relayClient.ts — the playground's side of the share relay contract (ADR-0064, AC20–22).
//
// Three calls, one origin (`SHARE_RELAY_ORIGIN`, single-homed in config/site.ts; empty
// means "no relay" and nothing here is reachable from the UI). The KEY never enters this
// module's requests: `upload` takes ciphertext, `download` takes an id, `revoke` takes
// the token the relay minted — `bundleCrypto.ts` is the only place a key is handled, and
// `relayClient.test.ts` spies fetch to prove no request URL, header or body carries one.
//
// Goes through the platform fetch seam so the desktop shell's native fetch (CORS-free)
// is used there and the browser's fetch on web.

import { SHARE_LINK_ORIGIN, SHARE_LINK_PATH, SHARE_RELAY_ORIGIN } from '../config/site.js';
import { getPlatform } from '../platform/platform.js';

export const SHARE_ID_RULE = /^[A-Za-z0-9_-]{22}$/;
export const SHARE_TOKEN_RULE = /^[A-Za-z0-9_-]{43}$/;

/** The sharer's lifetime choices — the relay's closed set (`handler.mjs` EXPIRY_CHOICES). */
export type ShareExpiry = '1d' | '7d' | '30d';
export const SHARE_EXPIRY_CHOICES: readonly { value: ShareExpiry; label: string }[] = [
  { value: '1d', label: '24 hours' },
  { value: '7d', label: '1 week' },
  { value: '30d', label: '1 month' },
];
export const DEFAULT_SHARE_EXPIRY: ShareExpiry = '7d';

export interface UploadedShare {
  id: string;
  expiresAt: string;
  revokeToken: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function fetchImpl(): FetchLike {
  const seat = getPlatform().fetchImpl;
  return seat !== undefined ? (input, init) => seat(input, init) : (input, init) => globalThis.fetch(input, init);
}

function relayUrl(path: string): string {
  if (SHARE_RELAY_ORIGIN === '') throw new Error('share links are not available in this build (no relay configured)');
  return `${SHARE_RELAY_ORIGIN}${path}`;
}

export async function uploadCiphertext(ciphertext: Uint8Array, expires: ShareExpiry = DEFAULT_SHARE_EXPIRY): Promise<UploadedShare> {
  const response = await fetchImpl()(relayUrl(`/v1/bundles?expires=${expires}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext as unknown as BodyInit,
  });
  if (response.status === 413) throw new Error('this app is too large to share by link — send the .snug file instead');
  if (!response.ok) throw new Error(`the share relay refused the upload (${response.status})`);
  const json = (await response.json()) as Partial<UploadedShare>;
  if (typeof json.id !== 'string' || !SHARE_ID_RULE.test(json.id)) throw new Error('the share relay answered without an id');
  if (typeof json.expiresAt !== 'string' || Number.isNaN(Date.parse(json.expiresAt))) throw new Error('the share relay answered without an expiry');
  if (typeof json.revokeToken !== 'string' || !SHARE_TOKEN_RULE.test(json.revokeToken)) throw new Error('the share relay answered without a revoke token');
  return { id: json.id, expiresAt: json.expiresAt, revokeToken: json.revokeToken };
}

export type DownloadResult = { ok: true; ciphertext: Uint8Array } | { ok: false; reason: 'gone' | 'unreachable' };

export async function downloadCiphertext(id: string): Promise<DownloadResult> {
  if (!SHARE_ID_RULE.test(id)) return { ok: false, reason: 'gone' };
  let response: Response;
  try {
    response = await fetchImpl()(relayUrl(`/v1/bundles/${id}`), { method: 'GET' });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 404) return { ok: false, reason: 'gone' };
  if (!response.ok) return { ok: false, reason: 'unreachable' };
  return { ok: true, ciphertext: new Uint8Array(await response.arrayBuffer()) };
}

/** Best-effort: a recipient who already fetched keeps the bytes (ADR-0064 consequences). */
export async function revokeShare(id: string, revokeToken: string): Promise<boolean> {
  if (!SHARE_ID_RULE.test(id) || !SHARE_TOKEN_RULE.test(revokeToken)) return false;
  const response = await fetchImpl()(relayUrl(`/v1/bundles/${id}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${revokeToken}` },
  });
  return response.status === 204;
}

/** The link a recipient opens: the hosted playground's receiver page, key in the fragment. */
export function shareLinkFor(id: string, key: string): string {
  return `${SHARE_LINK_ORIGIN}${SHARE_LINK_PATH}/${id}#${key}`;
}

/** The desktop deep link the receiver page offers on macOS (phase 2, AC18). */
export function desktopLinkFor(id: string, key: string): string {
  return `snug://s/${id}#${key}`;
}

/** Parse either link shape strictly; anything else is `undefined`. */
export function parseShareLink(url: string): { id: string; key: string } | undefined {
  const match = /^(?:snug:\/\/s\/|https:\/\/[^/]+\/s\/)([A-Za-z0-9_-]{22})#([A-Za-z0-9_-]{43})$/.exec(url.trim());
  if (match === null) return undefined;
  return { id: match[1]!, key: match[2]! };
}

// receiveShareLink.ts — the ONE act behind a share link on every platform (AC20/AC18):
// the web `/s/:id` page and the desktop `snug://s/<id>#<key>` handler both call this.
// Fetch the ciphertext, decrypt with the fragment key, validate at the boundary, place
// the bundle on the shelf IN MEMORY (a link visit never writes the user file), and hand
// back the bundle id to navigate to. Every failure is a named reason the UI can explain.

import { decryptBundle } from './bundleCrypto.js';
import { SHARE_ID_RULE, downloadCiphertext, parseShareLink } from './relayClient.js';
import { receiveSharedBundle } from './sharedInbox.js';
import { SHARE_RELAY_ORIGIN } from '../config/site.js';

export type ShareLinkFailure = 'bad-link' | 'no-relay' | 'gone' | 'unreachable' | 'bad-key' | 'invalid' | 'shelf-full';

export type ReceiveShareLinkResult = { ok: true; bundleId: string } | { ok: false; reason: ShareLinkFailure };

export async function receiveShareLink(id: string, key: string): Promise<ReceiveShareLinkResult> {
  if (!SHARE_ID_RULE.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return { ok: false, reason: 'bad-link' };
  if (SHARE_RELAY_ORIGIN === '') return { ok: false, reason: 'no-relay' };
  const fetched = await downloadCiphertext(id);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  const opened = await decryptBundle(fetched.ciphertext, key);
  if (!opened.ok) return { ok: false, reason: 'bad-key' };
  const text = new TextDecoder().decode(opened.plaintext);
  const received = await receiveSharedBundle(text, { source: 'link', persist: false, link: { id, key } });
  if (!received.ok) return { ok: false, reason: received.reason === 'shelf-full' ? 'shelf-full' : 'invalid' };
  return { ok: true, bundleId: received.entry.bundleId };
}

/** The desktop deep-link handler's entry: a full `snug://s/<id>#<key>` string, strictly parsed. */
export async function receiveShareLinkUrl(url: string): Promise<ReceiveShareLinkResult> {
  const parsed = parseShareLink(url);
  if (parsed === undefined) return { ok: false, reason: 'bad-link' };
  return receiveShareLink(parsed.id, parsed.key);
}

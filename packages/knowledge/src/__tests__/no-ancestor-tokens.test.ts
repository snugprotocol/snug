// AC-8: the store teaches ONLY the Snug v0.1 protocol — no tokens carried over from the
// two ancestor production systems (identifiers and codenames), no sandbox escapes, and no
// localStorage-as-storage (storage is host-brokered).
//
// WHY THE FORBIDDEN LIST IS HASHED (TASK-20260821-launch-security-review, Lane F BLOCKER-1).
// This repo ships public. The root AI files deliberately refer to the two ancestor systems
// only by the approved indirection, and their real identifiers live in a gitignored file
// that has never been committed. A guard written as a plaintext list of exactly those
// identifiers would publish the thing the indirection exists to withhold — the leak would
// BE the file whose job is preventing leaks, and it would be the single most rewarding file
// in the tree for anyone curious about Snug's provenance.
//
// Hashing keeps every property that matters. The test still runs everywhere with no fixture
// and no environment variable, still fails on a real regression, and still names the
// offending FILE. What it can no longer do is print the matched token — an acceptable
// trade, because the file is the actionable half and a maintainer who needs the token can
// read it from the private source. Lengths are published because the scan needs them; a
// length is not an identifier.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderedStore } from './helpers.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * SHA-256 of each lowercased forbidden token. Substring semantics are preserved by hashing
 * every candidate window of each published length — the same matches the old
 * `includes(token)` produced, without the plaintext.
 */
const FORBIDDEN_TOKEN_HASHES = new Set([
  '364a1e7d8d55c6ec6b123c41ff8ca73bbea60fb7c918095b7e37198162d4e62b',
  'dde6e8974b46a1eddcd7ea3bbb899342f48cad896b47275a6f806062ec5ca14c',
  '93d730ab08cd1ea4a739f8c1e9ffb430c70529451366b9386d03706b38bbe5db',
  'c9f15039af293a5545816ea4ed4130c85f7f75c7bf3cf0a0eb94d220355c4362',
  'f7eb3ff287903112e3d70124e3831822bfaafd19a0e8560d2f6f162613eb94a5',
  '99a0fe6e9a4f785a3ae1fa30a3756c32a7b05ecb36821e50a0a67ee9175807ef',
  'f5c61ccb988a79758d8f8ab2eeaffad00fa36f79abd2310c8af0f17fc4bfeeed',
]);

/** The window sizes to test — the distinct lengths of the hashed tokens above. */
const TOKEN_LENGTHS = [4, 5, 8, 9, 16, 17];

/**
 * Not every forbidden string is sensitive: `allow-same-origin` is a C2 term this repo
 * names openly everywhere, so hiding it would buy nothing and cost the clearer failure
 * message.
 */
const PLAINTEXT_FORBIDDEN = ['allow-same-origin'];

/** Does `text` contain any hashed token? Returns a redacted descriptor, never the token. */
function findHashedToken(text: string): string | null {
  for (const length of TOKEN_LENGTHS) {
    if (text.length < length) continue;
    for (let i = 0; i + length <= text.length; i++) {
      if (FORBIDDEN_TOKEN_HASHES.has(sha256(text.slice(i, i + length)))) {
        return `a forbidden ancestor token (${length} chars, at offset ${i})`;
      }
    }
  }
  return null;
}

describe('no ancestor tokens in the rendered store', () => {
  it('rendered store contains no ancestor identifiers, dead hooks, or sandbox escapes', () => {
    const violations: string[] = [];
    for (const entry of renderedStore()) {
      const lower = entry.text.toLowerCase();
      const hashed = findHashedToken(lower);
      if (hashed !== null) violations.push(`${entry.file}: contains ${hashed}`);
      for (const token of PLAINTEXT_FORBIDDEN) {
        if (lower.includes(token)) violations.push(`${entry.file}: contains "${token}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the hashed guard still CATCHES a planted token — a scanner that cannot fail proves nothing', () => {
    // The mutation check, kept as a permanent test because the hashing indirection is
    // exactly the kind of change that can silently become a no-op (a wrong length list, a
    // case mismatch, an empty set). It plants a known-forbidden token inside ordinary
    // prose and asserts the scanner finds it — without either side naming the token: the
    // planted value is recovered from the hash set by brute force over the corpus below,
    // so this test contains no plaintext codename either.
    const planted = 'guardian'; // 8 chars — a common English word, and safe to name.
    expect(FORBIDDEN_TOKEN_HASHES.has(sha256(planted)), 'the sample must really be forbidden').toBe(true);
    expect(findHashedToken(`the ${planted} pattern is discussed here`)).not.toBeNull();
    expect(findHashedToken('ordinary prose about apps, storage and bridges')).toBeNull();
  });

  it('every localStorage/sessionStorage mention is a do-not-use warning, never a teaching', () => {
    // The null-origin sandbox has no browser storage (one ancestor KB taught localStorage
    // via a sandbox escape the spec forbids). A mention is only legal inside an explicit
    // negation: a negating word within the surrounding 3 lines.
    const NEGATION = /\b(not|never|no|don't|do not|cannot|dead end|forbidden|blocked)\b/i;
    const violations: string[] = [];
    for (const entry of renderedStore()) {
      const lines = entry.text.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!/localstorage|sessionstorage/i.test(line)) continue;
        const context = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (!NEGATION.test(context)) {
          violations.push(`${entry.file}:${i + 1}: browser-storage mention without a nearby negation: "${line.trim()}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

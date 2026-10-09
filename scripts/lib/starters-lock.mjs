// starters-lock.mjs — the committed record of `@snugprotocol/starters`' published bytes
// (TASK-20261008-p0-clearance W1, ADR-0073). Pure: no filesystem, no network.
//
// `examples/starters-lock.json` maps every version to the sha384 of every wrapper. A kit
// bakes the hashes of the version its pin names (SRI on the jsDelivr `<script>`), and an npm
// version can never be republished — so once a version is published its bytes are frozen,
// and the only honest response to a changed starter is a new version. Before publication the
// lock is a staging record: drift there is cured by re-staging, not by burning a version.
//
// Lock shape (sorted keys, two-space JSON, LF):
//   { format, name, versions: { "<v>": { ref?, published, integrity?, starters: { folder: sha384 } } } }
// `ref` names the commit an OLDER version's bytes are built from (with that commit's own
// builder — a wrapper embeds its version string, so another builder cannot reproduce it);
// the version the pin currently names is built from HEAD and carries no ref.

export const STARTERS_LOCK_FORMAT = 'snug-starters-lock/1';

/** One lock entry from a built `index.json`. Never published at birth. */
export function lockEntryFromIndex(index, { ref } = {}) {
  const starters = Object.fromEntries(Object.entries(index.starters).map(([folder, entry]) => [folder, entry.sha384]));
  return { ...(ref !== undefined ? { ref } : {}), published: false, starters };
}

/**
 * Compare a freshly built index (the pinned version) with the lock.
 * → { status: 'ok' | 'missing-entry' | 'drift' | 'name-mismatch', version, published?, changed, added, removed }
 */
export function compareToLock({ index, lock }) {
  const version = index.version;
  const base = { version, changed: [], added: [], removed: [] };
  if (lock.name !== index.name) return { ...base, status: 'name-mismatch', lockName: lock.name, name: index.name };
  const entry = lock.versions?.[version];
  if (entry === undefined) return { ...base, status: 'missing-entry' };
  const built = Object.fromEntries(Object.entries(index.starters).map(([folder, e]) => [folder, e.sha384]));
  const changed = Object.keys(built).filter((f) => f in entry.starters && entry.starters[f] !== built[f]).sort();
  const added = Object.keys(built).filter((f) => !(f in entry.starters)).sort();
  const removed = Object.keys(entry.starters).filter((f) => !(f in built)).sort();
  const status = changed.length + added.length + removed.length === 0 ? 'ok' : 'drift';
  return { status, version, published: entry.published === true, changed, added, removed };
}

/** The sentence that tells a contributor what to do — every failure names its fix. */
export function remedyFor(result) {
  const v = result.version;
  switch (result.status) {
    case 'ok':
      return `@${v} matches the lock`;
    case 'name-mismatch':
      return `the lock is for ${result.lockName}, the pin names ${result.name} — fix examples/starters-package.json or the lock`;
    case 'missing-entry':
      return `the pin names ${v} but examples/starters-lock.json has no entry for it — run: node scripts/publish-starters.mjs --stage`;
    case 'drift': {
      const what = [
        result.changed.length ? `changed: ${result.changed.join(', ')}` : '',
        result.added.length ? `added: ${result.added.join(', ')}` : '',
        result.removed.length ? `removed: ${result.removed.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      return result.published
        ? `the starters built from examples/ no longer match the PUBLISHED ${v} (${what}). Published bytes are immutable and every kit at this pin bakes their sha384 — bump the version in examples/starters-package.json, then run: node scripts/publish-starters.mjs --stage`
        : `the starters built from examples/ no longer match the staged (unpublished) ${v} (${what}) — run: node scripts/publish-starters.mjs --stage`;
    }
    default:
      return `unknown status ${result.status}`;
  }
}

/** Compare dotted numeric versions (the lock only ever holds plain x.y.z). */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function sortedObject(obj, compare) {
  return Object.fromEntries(Object.keys(obj).sort(compare).map((k) => [k, obj[k]]));
}

/** Stable bytes: versions ascending, entry keys in a fixed order, starters sorted, LF. */
export function serializeLock(lock) {
  const versions = {};
  for (const v of Object.keys(lock.versions).sort(compareVersions)) {
    const e = lock.versions[v];
    versions[v] = {
      ...(e.ref !== undefined ? { ref: e.ref } : {}),
      published: e.published === true,
      ...(e.integrity !== undefined ? { integrity: e.integrity } : {}),
      starters: sortedObject(e.starters),
    };
  }
  return `${JSON.stringify({ format: STARTERS_LOCK_FORMAT, name: lock.name, versions }, null, 2)}\n`;
}

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

/**
 * A failure to REACH the other side, as opposed to an answer from it. A check that hits one
 * has learned nothing about its input: NOT VERIFIED, never a pass and never a failure.
 */
export function isNetworkError(err) {
  if (err === null || typeof err !== 'object') return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const code = err.code ?? err.cause?.code;
  return typeof code === 'string' && NETWORK_CODES.has(code);
}

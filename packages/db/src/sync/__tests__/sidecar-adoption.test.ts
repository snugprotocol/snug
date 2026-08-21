// TASK-20260820 — the sync sidecar must move with the file (AC21, plan review B2).
//
// WHY THIS EXISTS. The sidecar name is derived from the db file name
// (`sidecarFileFor(file) = ${file}.sync.json`), so renaming `user.sqlite` to
// `user.snug` silently orphans it. `loadSidecar` is a TOTAL parser — a missing file
// returns `{}`, which is indistinguishable from "never pushed". Walk what
// `reconcileOnStart` then computes for a user who has been syncing happily for months:
//
//   localChanged = hash !== undefined            -> true   (sidecar forgot the hash)
//   remoteMoved  = remote.revision !== undefined -> true   (sidecar forgot the revision)
//   both moved                                   -> DIVERGENCE
//
// So every existing sync user is told their file diverged, on a file that did not.
// If they resolve it by picking "use the origin copy", `pullMerge` imports the remote
// image over local and anything written since the last push is gone. That is data
// loss caused by nothing but a rename — which is why this is tested at the seam
// rather than trusted to a code comment.
import { describe, expect, it } from 'vitest';
import { USERDB_FILE, USERDB_LEGACY_FILE } from '@snugprotocol/protocol';

import { createMemoryBackend } from '../../persistence.js';
import { adoptLegacySidecar, loadSidecar, saveSidecar, sidecarFileFor } from '../sidecar.js';

const ANCHORED = { lastPushedRevision: 'r7-abc', lastPushedHash: 'deadbeef', lastSyncAt: '2026-08-19T10:00:00.000Z' };

describe('sidecar adoption across the rename (AC21)', () => {
  it('reads the legacy sidecar when the canonical one is absent — no phantom divergence', async () => {
    const backend = createMemoryBackend();
    await saveSidecar(backend, USERDB_LEGACY_FILE, ANCHORED);

    await adoptLegacySidecar(backend, USERDB_FILE, USERDB_LEGACY_FILE);

    // The anchor survived: the loop will see "unchanged" and stay quiet, which is the
    // entire point. An empty {} here is the bug this test exists to prevent.
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual(ANCHORED);
  });

  it('is idempotent — running it again does not clobber a newer canonical anchor', async () => {
    const backend = createMemoryBackend();
    await saveSidecar(backend, USERDB_LEGACY_FILE, ANCHORED);
    await adoptLegacySidecar(backend, USERDB_FILE, USERDB_LEGACY_FILE);

    // The loop pushes and re-anchors...
    const newer = { lastPushedRevision: 'r8-xyz', lastPushedHash: 'cafef00d', lastSyncAt: '2026-08-20T09:00:00.000Z' };
    await saveSidecar(backend, USERDB_FILE, newer);
    // ...and a later boot runs adoption again, as every boot will.
    await adoptLegacySidecar(backend, USERDB_FILE, USERDB_LEGACY_FILE);

    // Re-adopting a STALE legacy anchor over a newer one would re-push the whole file
    // and, worse, hand a stale base revision to a conditional write.
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual(newer);
  });

  it('does nothing when there is no legacy sidecar (a fresh install)', async () => {
    const backend = createMemoryBackend();
    await adoptLegacySidecar(backend, USERDB_FILE, USERDB_LEGACY_FILE);
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual({});
  });

  it('leaves the legacy sidecar in place, like the legacy db file', async () => {
    const backend = createMemoryBackend();
    await saveSidecar(backend, USERDB_LEGACY_FILE, ANCHORED);
    await adoptLegacySidecar(backend, USERDB_FILE, USERDB_LEGACY_FILE);
    expect(await backend.load(sidecarFileFor(USERDB_LEGACY_FILE))).toBeDefined();
  });

  it('survives a corrupt legacy sidecar without throwing (it is only an optimisation)', async () => {
    const backend = createMemoryBackend();
    await backend.save(sidecarFileFor(USERDB_LEGACY_FILE), new TextEncoder().encode('SNUGSYNC1\n{not json'));
    await expect(adoptLegacySidecar(backend, USERDB_FILE, USERDB_LEGACY_FILE)).resolves.toBeUndefined();
    // A garbage anchor must not be propagated as though it were real.
    expect(await loadSidecar(backend, USERDB_FILE)).toEqual({});
  });
});

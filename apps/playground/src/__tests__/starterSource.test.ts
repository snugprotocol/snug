// starterSource.test.ts — TASK-20260905-host-kit AC14 (A3): ONE module owns every
// `examples/` glob the starter shelf, metadata, contracts, authoring docs and connection
// manifests read through — `starter/starterSource.ts`. The host kit aliases exactly that
// module to an on-demand implementation, which is the only way to keep the ≈ 1.04 MB of
// starter bytes out of a single-file bundle (`import.meta.glob` is build-time and
// `inlineDynamicImports` inlines every lazy chunk). This suite pins the refactor as
// BEHAVIOR-PRESERVING against the files on disk, and the interface the kit implements.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listStarterApps, loadStarterHtml, STARTER_PREFIX } from '../starter/starterApps.js';
import { bundledStarterAuthoring } from '../starter/starterDocs.js';
import { starterMetaFor } from '../starter/starterMeta.js';
import { bundledStarterContracts } from '../starter/starterRuntimeContract.js';
import { starterDeclarationForStarterId } from '../starter/starterDeclaration.js';
import { starterSource, type StarterSource } from '../starter/starterSource.js';

const EXAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples');
const foldersOnDisk = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(EXAMPLES, d.name, 'app.html')))
  .map((d) => d.name)
  .sort();

describe('starterSource — the one owner of the examples globs', () => {
  it('lists exactly the starter folders that ship an app.html, sorted', () => {
    const source: StarterSource = starterSource();
    expect(source.appFolders()).toEqual(foldersOnDisk);
    expect(foldersOnDisk.length).toBeGreaterThanOrEqual(12);
  });

  it('serves each artifact class from the same folder set the files on disk define', async () => {
    const source = starterSource();
    const chessHtml = await source.html('chess');
    expect(chessHtml).toBe(readFileSync(path.join(EXAMPLES, 'chess', 'app.html'), 'utf8'));
    expect(await source.meta('chess')).toBe(readFileSync(path.join(EXAMPLES, 'chess', 'starter.json'), 'utf8'));
    expect(await source.contract('chess')).toBe(readFileSync(path.join(EXAMPLES, 'chess', 'runtime-contract.json'), 'utf8'));
    expect(await source.manifest('trade-copilot')).toBe(
      readFileSync(path.join(EXAMPLES, 'trade-copilot', 'connection.json'), 'utf8'),
    );
    expect(await source.manifest('chess')).toBeUndefined(); // a non-declaring starter
    expect(await source.html('no-such-starter')).toBeUndefined();
    const authoring = await source.authoring();
    expect(Object.keys(authoring).sort()).toEqual(
      foldersOnDisk.filter((f) => existsSync(path.join(EXAMPLES, f, 'authoring'))).sort(),
    );
  });
});

describe('the five consumers read through the source — behavior byte-identical to the globs they owned', () => {
  it('the shelf lists the same ids and serves the same html', async () => {
    expect(listStarterApps().map((s) => s.id)).toEqual(foldersOnDisk.map((f) => `${STARTER_PREFIX}${f}`));
    expect(await loadStarterHtml(`${STARTER_PREFIX}quiz-me`)).toBe(readFileSync(path.join(EXAMPLES, 'quiz-me', 'app.html'), 'utf8'));
    expect(await loadStarterHtml(`${STARTER_PREFIX}nope`)).toBeUndefined();
  });

  it('metadata, contracts, authoring and declarations resolve as before', async () => {
    const meta = await starterMetaFor('chess');
    expect(meta?.version).toBeGreaterThanOrEqual(1);
    expect(await starterMetaFor('no-such-starter')).toBeUndefined();
    const contracts = await bundledStarterContracts();
    expect(Object.keys(contracts).sort()).toEqual(
      foldersOnDisk.filter((f) => existsSync(path.join(EXAMPLES, f, 'runtime-contract.json'))).sort(),
    );
    const authoring = await bundledStarterAuthoring();
    expect(authoring['trade-copilot']?.docs).toBeDefined();
    expect(await starterDeclarationForStarterId(`${STARTER_PREFIX}trade-copilot`)).not.toBeNull();
    expect(await starterDeclarationForStarterId(`${STARTER_PREFIX}chess`)).toBeNull();
  });
});

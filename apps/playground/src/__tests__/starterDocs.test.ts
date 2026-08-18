// TASK-20260817-telepath Phase F (ADR-0035): the starter's authoring docs become the
// installed app's wiki seed.
//
// WHAT THIS PROVES. ADR-0031's AC9 gate made every connected starter ship an `authoring/`
// bundle whose doc slugs are 1:1 with `snug_app_docs` — "for a future ingestion phase the
// owner will specify". This is that phase. The properties worth testing are the ones whose
// failure is silent:
//
//   (1) SEEDING HAPPENS AT ALL, and only for a starter-installed app. An app the user
//       built has no bundled folder to read and must never inherit another app's docs.
//   (2) ABSENT SLUGS ONLY. The wiki is the app's LIVING memory (ADR-0010): a re-install
//       must not clobber what the user's own sessions have compounded. Tested per slug,
//       including the PARTIAL state (some slugs present, some missing) — the shape of
//       eight-seams defect #6, where a half-completed flow wedged every retry.
//   (3) THE BUILD PROMPT LANDS as its own slug, in numbered order — requirement 10 of the
//       owner's brief is that the prompt which drove the app is readable in the DB.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  installStarterDocs,
  __setStarterDocFixturesForTests,
  __resetStarterDocFixturesForTests,
} from '../starter/starterDocs.js';
import { installTestUserDb } from './userdbTestHelper.js';
import type { UserDb } from '@snugprotocol/db';

const FIXTURES = {
  whatsapp: {
    docs: {
      'vision.md': '# Vision\n\nTelepath is your WhatsApp with an analyst on tap.',
      'requirements.md': '# Requirements\n\nThe ten things it must do.',
      'plan.md': '# Plan\n\nContract first, then the sidecar.',
    },
    prompts: {
      '01-build.md': '# Build prompt\n\nRebuild the WhatsApp twin, ultra cool.',
      '02-followup.md': '# Follow-up\n\nAnd add the charts tab.',
    },
  },
};

/** Install an app row the way the starter path does, then hand back its id. */
async function installedStarterApp(db: UserDb, folder = 'whatsapp'): Promise<string> {
  const app = db.installApp({
    displayName: 'Telepath',
    html: '<!DOCTYPE html><html></html>',
    installSource: `starter:${folder}`,
  });
  return app.appId;
}

describe('installStarterDocs', () => {
  beforeEach(() => __setStarterDocFixturesForTests(FIXTURES));
  afterEach(() => __resetStarterDocFixturesForTests());

  it('seeds every authored doc slug, with the H1 as its title', async () => {
    const db = await installTestUserDb();
    const appId = await installedStarterApp(db);

    await installStarterDocs(db, appId);

    const slugs = db.listAppDocs(appId).map((doc) => doc.slug).sort();
    expect(slugs).toEqual(['build-prompt', 'plan', 'requirements', 'vision']);
    const vision = db.getAppDoc(appId, 'vision');
    expect(vision?.title).toBe('Vision');
    expect(vision?.content).toContain('analyst on tap');
  });

  it('concatenates the numbered prompts into ONE build-prompt slug, in order', async () => {
    const db = await installTestUserDb();
    const appId = await installedStarterApp(db);

    await installStarterDocs(db, appId);

    const prompt = db.getAppDoc(appId, 'build-prompt');
    expect(prompt?.content).toContain('ultra cool');
    expect(prompt?.content).toContain('charts tab');
    expect(prompt!.content.indexOf('ultra cool')).toBeLessThan(prompt!.content.indexOf('charts tab'));
  });

  it('never clobbers a doc the user already has — the wiki is living memory', async () => {
    const db = await installTestUserDb();
    const appId = await installedStarterApp(db);
    db.putAppDoc(appId, 'vision', { title: 'My own vision', content: 'What I decided this app is for.' });

    await installStarterDocs(db, appId);

    expect(db.getAppDoc(appId, 'vision')?.content).toBe('What I decided this app is for.');
    // …and the absent ones still land.
    expect(db.getAppDoc(appId, 'plan')?.content).toContain('Contract first');
  });

  it('fills only the GAPS from a partial prior state (the half-completed-flow shape)', async () => {
    const db = await installTestUserDb();
    const appId = await installedStarterApp(db);
    // A previous install that died mid-loop, or a user who deleted one page.
    db.putAppDoc(appId, 'vision', { content: 'kept' });
    db.putAppDoc(appId, 'build-prompt', { content: 'kept too' });

    await installStarterDocs(db, appId);

    expect(db.getAppDoc(appId, 'vision')?.content).toBe('kept');
    expect(db.getAppDoc(appId, 'build-prompt')?.content).toBe('kept too');
    expect(db.getAppDoc(appId, 'requirements')?.content).toContain('ten things');
    expect(db.getAppDoc(appId, 'plan')?.content).toContain('Contract first');
  });

  it('seeds nothing for an app that was BUILT rather than installed from a starter', async () => {
    const db = await installTestUserDb();
    const built = db.installApp({ displayName: 'Something I made', html: '<!DOCTYPE html><html></html>' });

    await installStarterDocs(db, built.appId);

    expect(db.listAppDocs(built.appId)).toEqual([]);
  });

  it('seeds nothing for a starter with no authoring bundle, and never throws', async () => {
    const db = await installTestUserDb();
    const appId = await installedStarterApp(db, 'chess'); // LLM-free starter, no bundle

    await expect(installStarterDocs(db, appId)).resolves.toBeUndefined();
    expect(db.listAppDocs(appId)).toEqual([]);
  });
});

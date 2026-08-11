// AL-04 AC5 — the playground counterpart of the db-level custody canaries (AL-02
// wrote those naming AL-04 as the forward constraint). Byte-level probes over a
// full export AFTER completed wizard runs: credential values, pasted docs, and
// inferrer evidence must never reach chat rows, chat meta, context assembly, or
// any default-export byte. Mutations M10 (docs into meta), M17 (evidence into
// meta), M18 (inspector wiring), M30 (meta into context).
//
// P3 CUTOVER: the SURFACE moved to v4 (`snug_connections`, slot-keyed credentials, the
// v2 requirement inferrer); every CANARY is unchanged. That split is the point of keeping
// this file rather than deleting it with the v3 store — these are C1 custody claims, and
// a cutover is exactly the kind of change that quietly relocates a leak.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, type AuthWizardDirective } from '@snugprotocol/protocol';
import { createConnectionRequirementInferrer } from '@snugprotocol/auth';

import { buildAppTurnContext } from '../agent/appContext.js';
import { directiveToMeta } from '../agent/renderDirective.js';
import {
  __resetConnectionWizardForTests,
  advanceFromReview,
  openConnectionWizard,
} from '../state/connectionWizard.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP = 'app-canary';
const THREAD = 'thr-canary';
const CRED_CANARY = 'CANARY-cred-4be1a9c07d33';
const DOCS_CANARY = 'CANARY-docs-91f4e2ab6c55';
const EVIDENCE_CANARY = 'CANARY-evidence-77d0b3f912aa';

const SLOT = 'canary';

const apiKeyRequirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Canary API' },
  fields: [{ key: 'api_key', label: 'API Key', type: 'secret' as const }],
  declaredApiHosts: ['api.canary.example'],
};

const directive: AuthWizardDirective = {
  v: PROTOCOL_VERSION,
  kind: 'auth_wizard',
  proposal: { providerName: 'Canary API', kindHint: 'api_key', declaredApiHosts: ['ctx-probe.example'] },
};

function bytesContain(haystack: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= haystack.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** A COMPLETED wizard run: open → approve → credential written slot-keyed (v4). */
async function completeWizardRun(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Canary App', html: '<p>x</p>' });
  db.putDeclaredConnection(APP, SLOT, apiKeyRequirement, 'inference');
  openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
  const approved = await advanceFromReview();
  expect(approved.ok).toBe(true);
  db.setSecret(`auth:${APP}:${SLOT}:api_key`, CRED_CANARY);
  // A chat turn alongside, carrying the persisted (validated, evidence-free) directive.
  db.upsertThread(THREAD, { appId: APP });
  db.appendChatMessage(THREAD, 'user', 'connect my weather app please');
  db.appendChatMessage(THREAD, 'assistant', 'connect it below', { meta: directiveToMeta(directive) });
}

beforeEach(async () => {
  await installTestUserDb();
  __resetConnectionWizardForTests();
});
afterEach(() => {
  __resetConnectionWizardForTests();
});

describe('AC5 — canary.credential-value-never-in-chat-export (playground counterpart)', () => {
  it('after a completed wizard run, the DEFAULT export carries no credential bytes at all', async () => {
    await completeWizardRun();
    const db = await getUserDb();
    const bytes = await db.exportUserDb();
    expect(bytesContain(bytes, CRED_CANARY)).toBe(false);
  });

  it('chat rows (every column incl. meta) stay credential-free even in the FULL secrets export', async () => {
    await completeWizardRun();
    const db = await getUserDb();
    // The full export legitimately carries the secret (snug_secrets custody) …
    const full = await db.exportUserDb({ includeSecrets: true });
    expect(bytesContain(full, CRED_CANARY)).toBe(true);
    // … but never via chat: the serialized chat surface is byte-clean.
    expect(JSON.stringify(db.listChatMessages(THREAD))).not.toContain(CRED_CANARY);
  });

  it('canary.probe-detects-planted-secret — the probe CAN go red', async () => {
    await completeWizardRun();
    const db = await getUserDb();
    db.appendChatMessage(THREAD, 'assistant', `planted: ${CRED_CANARY}`);
    const bytes = await db.exportUserDb();
    expect(bytesContain(bytes, CRED_CANARY)).toBe(true); // the self-check
  });
});

describe('AC5/R5 — pasted docs and inferrer evidence are wizard-ephemeral (M10/M17)', () => {
  it('docs canary pasted at build + evidence canary echoed by the model: NEITHER persists anywhere', async () => {
    await completeWizardRun();
    const db = await getUserDb();

    // A REAL inferrer run over a reply that echoes both canaries. The evidence array is
    // the seat an M17-shaped bug would leak from, and the pasted docs ride in the prompt.
    const inferrer = createConnectionRequirementInferrer({
      complete: () =>
        Promise.resolve(
          JSON.stringify({
            requirement: {
              slot: SLOT,
              provider: { name: 'Canary API' },
              kind: 'api_key',
              fields: [{ key: 'api_key', label: 'API Key', type: 'secret', required: true }],
              declaredApiHosts: ['api.canary.example'],
            },
            confidence: 0.9,
            evidence: [`the docs said: ${EVIDENCE_CANARY}`],
          }),
        ),
    });
    const result = await inferrer.infer({
      providerName: 'Canary API',
      slot: SLOT,
      prompt: `provider docs body ${DOCS_CANARY}`,
      fromPastedDocs: true,
    });

    // The result HOLDS the evidence for review display — that is what makes the export
    // probe below meaningful rather than vacuous.
    expect(JSON.stringify(result.ok ? result.evidence : [])).toContain(EVIDENCE_CANARY);

    // The FULL export (secrets included) holds none of it: not the evidence, not the
    // pasted docs — no table, no meta, no column (M10/M17).
    const bytes = await db.exportUserDb({ includeSecrets: true });
    expect(bytesContain(bytes, EVIDENCE_CANARY)).toBe(false);
    expect(bytesContain(bytes, DOCS_CANARY)).toBe(false);
  });
});

describe('AC5/N2 — canary.meta-never-in-turn-context (M30)', () => {
  it('buildAppTurnContext over a thread with a persisted directive message never reads meta into context', async () => {
    await completeWizardRun();
    const db = await getUserDb();
    const context = await buildAppTurnContext(db, APP, THREAD);
    const serialized = JSON.stringify(context);
    // History carries the message CONTENT …
    expect(serialized).toContain('connect it below');
    // … and nothing from meta: the directive's marker host never enters the LLM turn.
    expect(serialized).not.toContain('ctx-probe.example');
  });
});

describe('AC5/D10 — canary.docs-never-in-llm-inspector (M18)', () => {
  it('no module on the inference path wires the LLM inspector or the turn-event feed', () => {
    // The inspector renders entry.system/messages verbatim and redacts only known
    // BYOK key shapes — pasted docs (which can hold a REAL key, R5) must never be
    // wired toward it. The wiring shapes a mutation would need are linted absent.
    for (const rel of [
      ['agent', 'inferrerAdapter.ts'],
      ['agent', 'connectionInferrerAdapter.ts'],
      ['state', 'connectionWizard.ts'],
      ['connections', 'ConnectionWizardSheet.tsx'],
    ] as const) {
      const text = readFileSync(join(__dirname, '..', ...rel), 'utf8');
      for (const forbidden of ['onLlmEvent', 'llmInspector', 'AgentTurnEvent', 'round_trip']) {
        expect(text.includes(forbidden), `${rel.join('/')} wires the inspector (${forbidden})`).toBe(false);
      }
    }
  });
});

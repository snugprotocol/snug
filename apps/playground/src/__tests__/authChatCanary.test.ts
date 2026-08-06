// AL-04 AC5 — the playground counterpart of the db-level custody canaries (AL-02
// wrote those naming AL-04 as the forward constraint). Byte-level probes over a
// full export AFTER completed wizard runs: credential values, pasted docs, and
// inferrer evidence must never reach chat rows, chat meta, context assembly, or
// any default-export byte. Mutations M10 (docs into meta), M17 (evidence into
// meta), M18 (inspector wiring), M30 (meta into context).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, type AuthWizardDirective } from '@snugprotocol/protocol';
import { UserDbCredentialStore } from '@snugprotocol/auth';

import { buildAppTurnContext } from '../agent/appContext.js';
import { directiveToMeta } from '../agent/renderDirective.js';
import {
  __resetWizardStateForTests,
  __setWizardHooksForTests,
  approveWizardSpec,
  openWizard,
  runWizardInference,
  wizardStore,
} from '../state/wizard.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP = 'app-canary';
const THREAD = 'thr-canary';
const CRED_CANARY = 'CANARY-cred-4be1a9c07d33';
const DOCS_CANARY = 'CANARY-docs-91f4e2ab6c55';
const EVIDENCE_CANARY = 'CANARY-evidence-77d0b3f912aa';

const apiKeySpec = {
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

/** A COMPLETED wizard run: open → approve → credential written through the store. */
async function completeWizardRun(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Canary App', html: '<p>x</p>' });
  db.putAuthSpec(APP, apiKeySpec);
  openWizard({ source: 'settings', appId: APP, mode: 'connect' });
  const approved = await approveWizardSpec();
  expect(approved.ok).toBe(true);
  await new UserDbCredentialStore(db).setCredential(APP, 'api_key', CRED_CANARY);
  // A chat turn alongside, carrying the persisted (validated, evidence-free) directive.
  db.upsertThread(THREAD, { appId: APP });
  db.appendChatMessage(THREAD, 'user', 'connect my weather app please');
  db.appendChatMessage(THREAD, 'assistant', 'connect it below', { meta: directiveToMeta(directive) });
}

beforeEach(async () => {
  await installTestUserDb();
  __resetWizardStateForTests();
});
afterEach(() => {
  __resetWizardStateForTests();
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
  it('docs canary pasted into the wizard + evidence canary echoed by the model: NEITHER persists anywhere', async () => {
    await completeWizardRun();
    const db = await getUserDb();
    __setWizardHooksForTests({
      runInference: async () => ({
        ok: true,
        provenance: 'user_docs',
        proposal: { providerName: 'Canary API', kindHint: 'api_key', declaredApiHosts: ['api.canary.example'] },
        confidence: 0.9,
        evidence: [`the docs said: ${EVIDENCE_CANARY}`],
        spec: null,
        reason: 'r',
      }),
    } as never);
    openWizard({ source: 'directive', appId: APP, directive });
    await runWizardInference({ providerName: 'Canary API', docsText: `docs body ${DOCS_CANARY}`, override: true });

    // Wizard-ephemeral: the session HOLDS the evidence for spec_confirm display …
    expect(JSON.stringify(wizardStore.get()?.evidence)).toContain(EVIDENCE_CANARY);

    // … and the FULL export (secrets included) holds none of it: not the evidence,
    // not the pasted docs — no table, no meta, no column (M10/M17).
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
      ['state', 'wizard.ts'],
      ['connections', 'AuthWizardSheet.tsx'],
    ] as const) {
      const text = readFileSync(join(__dirname, '..', ...rel), 'utf8');
      for (const forbidden of ['onLlmEvent', 'llmInspector', 'AgentTurnEvent', 'round_trip']) {
        expect(text.includes(forbidden), `${rel.join('/')} wires the inspector (${forbidden})`).toBe(false);
      }
    }
  });
});

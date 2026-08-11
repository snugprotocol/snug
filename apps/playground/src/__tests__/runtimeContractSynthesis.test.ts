/**
 * TASK-20260811-lean-runtime-data-chat, P2 — the post-turn contract synthesis fallback
 * (ADR-0018 D5, AC-F1-2, AC-F1-5, fold F-m7).
 *
 * WHY A FALLBACK EXISTS. The KB teaches the model to call `runtime_contract_write` after
 * building an app that talks to the agent. Models forget. An app with no contract still
 * works — it runs on the lean generic layers — but it loses the per-app framing that makes
 * a small local model answer well, and the user has no way to know. So the host asks on
 * their behalf, once, at the only moment it can: post-turn, when the artifact exists and
 * the reply is final.
 *
 * TRIGGER SCOPE IS THE WHOLE DESIGN (fold F-B1). It fires only when the app's version
 * lineage has NO contract anywhere. With D2's copy-forward that effectively means "first
 * build or first install". If it fired per-edit it would overwrite an authored contract
 * with a synthesized one on every cosmetic change — strictly worse than not existing.
 *
 * IT GOES THROUGH `runAgentTurn` WITH `onLlmEvent` WIRED (fold F-m7). The connection
 * inferrer's adapter seam bypasses the LLM inspector; this must not, or a token-spending
 * turn would be invisible in the very surface built to show token spend (AC-BOTH).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentTurnEvent } from '@snugprotocol/adapters';
import { runtimeContractSchema } from '@snugprotocol/protocol';

import { synthesizeRuntimeContract, needsSynthesizedContract } from '../agent/runtimeContractSynthesis.js';
import { installTestUserDb } from './userdbTestHelper.js';

const LLM_HTML = `<!DOCTYPE html><html><body><script>snug.sendMessage({action:'move'})</script></body></html>`;
const PLAIN_HTML = `<!DOCTYPE html><html><body><h1>A calculator</h1></body></html>`;

/** An adapter that returns one scripted reply and records what it was asked. */
function scriptedAdapter(text: string): { adapter: AgentAdapter; calls: Array<{ system: string }> } {
  const calls: Array<{ system: string }> = [];
  return {
    calls,
    adapter: {
      complete: async (request) => {
        calls.push({ system: request.system });
        return { ok: true as const, text, toolCalls: [], stopReason: 'end' as const };
      },
    },
  };
}

describe('needsSynthesizedContract — the trigger (fold F-B1)', () => {
  it('fires for an LLM-using app with no contract anywhere in its lineage', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    expect(needsSynthesizedContract(db, app.appId, LLM_HTML)).toBe(true);
  });

  it('does NOT fire when the app already has a contract (never overwrite an authored one)', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    db.putRuntimeContract(app.appId, app.currentVersion, runtimeContractSchema.parse({ overview: 'Authored.' }));
    expect(needsSynthesizedContract(db, app.appId, LLM_HTML)).toBe(false);
  });

  it('does NOT fire on a cosmetic edit of an app whose contract copied forward (AC-F1-5)', async () => {
    // This is the F-B1 case: without copy-forward the new version would look
    // contract-less and synthesis would fire on every edit, replacing authored text.
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    db.putRuntimeContract(app.appId, app.currentVersion, runtimeContractSchema.parse({ overview: 'Authored.' }));
    db.saveAppVersion(app.appId, `${LLM_HTML}<!-- blue button -->`);
    expect(needsSynthesizedContract(db, app.appId, LLM_HTML)).toBe(false);
  });

  it('does NOT fire for an app that never talks to the agent (ADR-0011 LLM-optional)', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Calculator', html: PLAIN_HTML });
    expect(needsSynthesizedContract(db, app.appId, PLAIN_HTML)).toBe(false);
  });

  it('detects the agent surface by the app’s own sendMessage call, not a persisted flag', async () => {
    // ADR-0011 forbids a `usesAgent` column; the probe is a post-turn heuristic over the
    // HTML the turn just wrote.
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'X', html: PLAIN_HTML });
    expect(needsSynthesizedContract(db, app.appId, PLAIN_HTML)).toBe(false);
    expect(needsSynthesizedContract(db, app.appId, LLM_HTML)).toBe(true);
  });

  it('an unknown app never triggers synthesis', async () => {
    const db = await installTestUserDb();
    expect(needsSynthesizedContract(db, 'no-such-app', LLM_HTML)).toBe(false);
  });
});

describe('synthesizeRuntimeContract — the mini-turn', () => {
  it('persists a parsed contract onto the app’s current version', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const { adapter } = scriptedAdapter(
      JSON.stringify({ overview: 'A chess app; you are the opponent.', responseGuidance: 'Reply {"move":"e2e4"}.' }),
    );

    const ok = await synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter });

    expect(ok).toBe(true);
    expect(db.getRuntimeContract(app.appId)?.overview).toBe('A chess app; you are the opponent.');
  });

  it('tolerates a fenced or chatty reply (models wrap JSON)', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const { adapter } = scriptedAdapter(
      'Here you go:\n```json\n{"overview":"A chess app."}\n```\nHope that helps!',
    );

    const ok = await synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter });

    expect(ok).toBe(true);
    expect(db.getRuntimeContract(app.appId)?.overview).toBe('A chess app.');
  });

  it('DEGRADES GRACEFULLY: an unparseable reply leaves the app contract-less, never throws', async () => {
    // The build must not fail because a bonus step failed. Contract-less is a supported
    // state (AC-F1-4), so the honest outcome is simply "no contract".
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const { adapter } = scriptedAdapter('I am not going to answer that.');

    const ok = await synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter });

    expect(ok).toBe(false);
    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });

  it('degrades gracefully when the adapter itself fails', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const adapter: AgentAdapter = {
      complete: async () => ({ ok: false as const, code: 'NETWORK_ERROR', message: 'offline', retryable: true }),
    };

    await expect(
      synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter }),
    ).resolves.toBe(false);
    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });

  it('rejects an over-bound synthesized contract rather than storing a truncated one', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const { adapter } = scriptedAdapter(JSON.stringify({ overview: 'x'.repeat(5000) }));

    const ok = await synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter });

    expect(ok).toBe(false);
    expect(db.getRuntimeContract(app.appId)).toBeUndefined();
  });
});

describe('F-m7 — the synthesis turn is VISIBLE in the LLM inspector (AC-BOTH)', () => {
  it('forwards round-trip events to onLlmEvent', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const { adapter } = scriptedAdapter(JSON.stringify({ overview: 'A chess app.' }));
    const events: AgentTurnEvent[] = [];

    await synthesizeRuntimeContract({
      db,
      appId: app.appId,
      html: LLM_HTML,
      adapter,
      onLlmEvent: (event) => events.push(event),
    });

    // The mutation check: unwiring onLlmEvent must be observable, so assert on the
    // event kinds a real turn produces rather than merely on a non-empty array.
    expect(events.some((e) => e.type === 'round_trip')).toBe(true);
    expect(events.some((e) => e.type === 'round_trip_start')).toBe(true);
  });

  it('runs tool-free — synthesis must never be able to write an artifact', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const calls: Array<{ tools?: unknown }> = [];
    const adapter: AgentAdapter = {
      complete: async (request) => {
        calls.push({ tools: request.tools });
        return {
          ok: true as const,
          text: JSON.stringify({ overview: 'A chess app.' }),
          toolCalls: [],
          stopReason: 'end' as const,
        };
      },
    };

    await synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter });

    expect(calls[0]?.tools).toBeUndefined();
  });

  it('passes the abort signal through so a cancelled build cancels synthesis (F-M4 shape)', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const seen: Array<AbortSignal | undefined> = [];
    const adapter: AgentAdapter = {
      complete: async (request) => {
        seen.push(request.signal);
        return {
          ok: true as const,
          text: JSON.stringify({ overview: 'A chess app.' }),
          toolCalls: [],
          stopReason: 'end' as const,
        };
      },
    };
    const controller = new AbortController();

    await synthesizeRuntimeContract({
      db,
      appId: app.appId,
      html: LLM_HTML,
      adapter,
      signal: controller.signal,
    });

    expect(seen[0]).toBe(controller.signal);
  });

  it('sends the app’s HTML as untrusted context, not as instructions', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Chess', html: LLM_HTML });
    const { adapter, calls } = scriptedAdapter(JSON.stringify({ overview: 'A chess app.' }));

    await synthesizeRuntimeContract({ db, appId: app.appId, html: LLM_HTML, adapter });

    // The instructions live in the SYSTEM slot; the app's own code is untrusted input
    // and must not be able to redefine the task.
    expect(calls[0]?.system).toMatch(/contract/i);
    expect(calls[0]?.system).not.toContain('snug.sendMessage');
  });
});

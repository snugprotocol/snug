/**
 * runtimeContractSynthesis — the post-turn fallback that gives an app a runtime contract
 * when its builder forgot to write one (ADR-0018 D5, AC-F1-2).
 *
 * WHY IT EXISTS. The KB teaches the model to call `runtime_contract_write` after building
 * an app that talks to the agent. Models forget, and a contract-less app fails SILENTLY:
 * it still runs (on the lean generic layers), it just answers worse, and nothing in the UI
 * says why. So the host asks once, on the user's behalf, at the only moment it can — after
 * the artifact exists and the reply is final.
 *
 * TRIGGER SCOPE IS THE DESIGN (fold F-B1). It fires only when the app has no contract
 * ANYWHERE in its version lineage. Because `saveAppVersion` copies contracts forward, that
 * effectively means "first build or first install". A per-edit trigger would overwrite an
 * authored contract with a synthesized one on every cosmetic change — worse than nothing.
 *
 * IT GOES THROUGH `runAgentTurn`, NOT AN ADAPTER SEAM (fold F-m7). The connection
 * inferrer's `completeWithAdapter` path bypasses the LLM inspector; a turn that spends the
 * user's tokens must be visible in the surface built to show token spend, so this one
 * wires `onEvent` through (AC-BOTH).
 *
 * FAILURE IS ALWAYS GRACEFUL. Every failure mode — adapter error, unparseable reply,
 * over-bound contract — leaves the app contract-less, which is a fully supported state
 * (AC-F1-4). A bonus step must never fail a build the user already completed.
 */

import { runAgentTurn, type AgentAdapter, type AgentTurnEvent } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { buildRuntimeContractSynthesisPrompt } from '@snugprotocol/knowledge';
import { runtimeContractSchema } from '@snugprotocol/protocol';

/**
 * Does this app's HTML talk to the agent?
 *
 * A HEURISTIC OVER THE HTML, never a persisted flag: ADR-0011 (LLM-optional apps) forbids
 * a `usesAgent` column, and rightly — an app's relationship to the model is a property of
 * its code, which the next edit can change. Matching the SDK's call shape rather than the
 * bare word keeps a doc comment mentioning "sendMessage" from tripping it.
 */
const AGENT_SURFACE_RE = /\bsendMessage\s*\(/;

export function htmlUsesAgent(html: string): boolean {
  return AGENT_SURFACE_RE.test(html);
}

/**
 * Should the host synthesize a contract for this app?
 *
 * True only when the app exists, its code talks to the agent, and NO version in its
 * lineage carries a contract. The lineage check is what keeps this to first builds.
 */
export function needsSynthesizedContract(db: UserDb, appId: string, html: string): boolean {
  if (!htmlUsesAgent(html)) return false;
  const app = db.getApp(appId);
  if (app === undefined) return false;
  return !db.listAppVersions(appId).some((version) => db.getRuntimeContract(appId, version.version) !== undefined);
}

export interface SynthesizeRuntimeContractInput {
  db: UserDb;
  appId: string;
  /** The HTML the turn just wrote — the evidence the contract is derived from. */
  html: string;
  adapter: AgentAdapter;
  signal?: AbortSignal;
  /** Wired so the synthesis turn appears in the LLM inspector like any other (F-m7). */
  onLlmEvent?: (event: AgentTurnEvent) => void;
}

/**
 * Extract the first JSON object from a model reply.
 *
 * Tolerant on purpose: the prompt asks for bare JSON, and models still wrap it in prose or
 * a fence. Being strict here would mean discarding a perfectly good contract over
 * packaging — and the schema, not this function, is what decides whether the CONTENT is
 * acceptable.
 */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Run the synthesis mini-turn and persist the result. Returns whether a contract landed.
 *
 * Tool-free by construction: no `tools` are passed, so this turn cannot write an artifact,
 * apply DDL, or touch a doc. It has exactly one job and exactly one way to fail.
 */
export async function synthesizeRuntimeContract(input: SynthesizeRuntimeContractInput): Promise<boolean> {
  const { db, appId, html, adapter, signal, onLlmEvent } = input;
  const app = db.getApp(appId);
  if (app === undefined) return false;

  const { system, user } = buildRuntimeContractSynthesisPrompt({ html });
  const result = await runAgentTurn({
    adapter,
    system,
    messages: [{ role: 'user', content: user }],
    // A one-shot well below any cacheable-prefix minimum — a breakpoint here would be a
    // pure write premium (ADR-0012).
    ...(signal !== undefined ? { signal } : {}),
    ...(onLlmEvent !== undefined ? { onEvent: onLlmEvent } : {}),
  });
  if (!result.ok) return false;

  const parsed = runtimeContractSchema.safeParse(firstJsonObject(result.text));
  if (!parsed.success) return false;

  try {
    db.putRuntimeContract(appId, app.currentVersion, parsed.data);
    return true;
  } catch {
    // A write refusal (size guard, missing row) is the same class of outcome as a bad
    // reply: the app runs contract-less.
    return false;
  }
}

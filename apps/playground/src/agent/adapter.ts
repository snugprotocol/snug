// adapter.ts — browser-direct adapter selection (ADR-0008). BYOK keys come from the
// user DB's snug_secrets (mode.ts) and go DIRECTLY to the provider from the page —
// never through the hub server. Local mode targets an OpenAI-compatible localhost
// endpoint. No key / mock provider? The demo brain is always available.

import {
  anthropicAdapter,
  localAdapter,
  mockAdapter,
  openaiAdapter,
  type AgentAdapter,
  type FetchLike,
  type MockTurn,
} from '@snugprotocol/adapters';

import type { ByokProvider, PlaygroundMode } from '../state/mode.js';
import { getPlatform } from '../platform/platform.js';
import { demoAuthChatScript, demoAuthVariant } from './demoAuth.js';
import { demoRequirementChatScript, demoRequirementVariant } from './demoRequirement.js';
import { DEMO_APP_HTML, DEMO_APP_REPLY, DEMO_APP_TITLE } from './demoApp.js';
import { ARTIFACT_WRITE_TOOL_NAME } from './tools.js';
import { webllmAdapter } from './webllm/webllmAdapter.js';
import { APP_BUILDER_TOOL_NAME } from '@snugprotocol/knowledge';

export type ByokPurpose = 'chat' | 'app';

/**
 * `'webllm'` is a DIRECT mode here but NOT a `PlaygroundMode`: it is reachable only
 * through the experimental `?webllm=1` brain override (state/webllm.ts) and must not
 * join the persisted mode union until GA (AL-07).
 */
export type DirectMode = Exclude<PlaygroundMode, 'subscription'> | 'webllm';

export interface TurnAdapterConfig {
  mode: DirectMode;
  provider: ByokProvider;
  key?: string;
  model?: string;
  localUrl?: string;
  /**
   * Test override ONLY. Production never passes this — the default is the platform
   * fetch (TASK-20260812, P0 amendment 8), so desktop's native transport reaches every
   * provider adapter through this ONE choke point with zero per-call-site edits.
   */
  fetch?: FetchLike;
}

/** The demo brain's chat script: consult the KB, write the artifact, sign off. */
function demoChatScript(): MockTurn[] {
  // AL-04 e2e seam (`?demoauth=<variant>`, the ?webllm=1 URL-flag precedent):
  // a deterministic auth-directive script; zero footprint when the flag is absent.
  const authVariant = demoAuthVariant();
  if (authVariant !== null) return demoAuthChatScript(authVariant);
  // P3 e2e seam (`?demoreq=<variant>`): the v4 `connection_requirement` script. Separate
  // from `?demoauth=` so the v3 variants keep working untouched.
  const requirementVariant = demoRequirementVariant();
  if (requirementVariant !== null) return demoRequirementChatScript(requirementVariant);
  return [
    {
      deltas: ['let me check the app template first…'],
      text: 'let me check the app template first…',
      toolCalls: [{ name: APP_BUILDER_TOOL_NAME, input: { query: 'mandatory html template bridge hooks' } }],
    },
    {
      deltas: ['\n\nwriting your app now.'],
      text: '\n\nwriting your app now.',
      toolCalls: [{ name: ARTIFACT_WRITE_TOOL_NAME, input: { content: DEMO_APP_HTML, title: DEMO_APP_TITLE } }],
    },
    {
      deltas: ['\n\ndone — I built you a tiny oracle. run it and ask it something.'],
      text: '\n\ndone — I built you a tiny oracle. run it and ask it something.',
    },
  ];
}

/** The demo brain's app-mode script: one JSON-only reply per request. */
function demoAppScript(): MockTurn[] {
  return [{ deltas: [DEMO_APP_REPLY], text: DEMO_APP_REPLY }];
}

/**
 * What a turn with this config actually runs on (TASK-20260826, ADR-0059 rule 2).
 *
 * THE routing decision, extracted so disclosure surfaces (the brain chip, the
 * per-turn provenance tag) consume the SAME derivation the constructor dispatches
 * on — a parallel re-derivation would lie exactly where it matters most: a keyed
 * provider with NO key falls through to the demo brain, silently by design here,
 * loudly on the surfaces that consume this.
 *
 * The kind VOCABULARY is single-homed here (Gate-5 review): the type derives from
 * the runtime list, so the meta reader's validation (`useBuilderChat`'s
 * metaToBrainKind) can never silently strip a newly-added kind.
 */
export const ADAPTER_KINDS = ['webllm', 'local', 'anthropic', 'openai', 'demo'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/**
 * The derivation's input carries key PRESENCE only — a type fact, so a consumer
 * that knows presence but must never touch values (the brain chip) needs no
 * sentinel, and a future key-shape-aware edit cannot creep into the routing
 * decision unnoticed (it would have to change this type).
 */
export interface AdapterRoute {
  mode: DirectMode;
  provider: ByokProvider;
  hasKey: boolean;
}

/** The ONE config→route mapping — both the constructor and the stamp go through it. */
export function routeOf(config: Pick<TurnAdapterConfig, 'mode' | 'provider' | 'key'>): AdapterRoute {
  return { mode: config.mode, provider: config.provider, hasKey: config.key !== undefined };
}

export function adapterKindFor(route: AdapterRoute): AdapterKind {
  if (route.mode === 'webllm') return 'webllm';
  if (route.mode === 'local') return 'local';
  if (route.provider === 'anthropic' && route.hasKey) return 'anthropic';
  if (route.provider === 'openai' && route.hasKey) return 'openai';
  return 'demo';
}

/**
 * A FRESH adapter per turn (the mock adapter consumes its script sequentially).
 * local mode ignores provider/key; byok needs a key for anthropic/openai — keyless
 * falls through to the demo brain (see `adapterKindFor`, which every disclosure
 * surface reads so this fall-through is never silent to the user).
 */
export function createTurnAdapter(config: TurnAdapterConfig, purpose: ByokPurpose): AgentAdapter {
  // The platform seam at the LLM choke point: desktop supplies its native fetch here,
  // web supplies nothing and the adapters keep their own `globalThis.fetch` default.
  const fetchImpl = config.fetch ?? getPlatform().fetchImpl;
  const fetchDep = fetchImpl !== undefined ? { fetch: fetchImpl } : {};
  const modelDep = config.model !== undefined ? { model: config.model } : {};
  const kind = adapterKindFor(routeOf(config));
  switch (kind) {
    case 'webllm':
      // The shared `model` setting holds byok/local wire ids (e.g. "llama3.2") — a
      // different namespace from web-llm prebuilt ids, so it is deliberately IGNORED:
      // the spike always loads the ADR-0015 default; the model picker is GA scope.
      return webllmAdapter();
    case 'local':
      return localAdapter({
        ...(config.localUrl !== undefined ? { baseUrl: config.localUrl } : {}),
        ...modelDep,
        ...fetchDep,
      });
    case 'anthropic':
    case 'openai': {
      const { key } = config;
      if (key === undefined) {
        // Unreachable by construction — adapterKindFor names a keyed provider only
        // when its key exists. Loud on purpose: if the derivation ever drifts from
        // this dispatch, a throw beats silently routing the user's turn elsewhere.
        throw new Error(`adapterKindFor said '${kind}' without a key`);
      }
      return kind === 'anthropic'
        ? anthropicAdapter({ apiKey: key, ...modelDep, ...fetchDep })
        : openaiAdapter({ apiKey: key, ...modelDep, ...fetchDep });
    }
    case 'demo':
      return paced(mockAdapter(purpose === 'chat' ? demoChatScript() : demoAppScript()), demoSlowMs());
  }
}

/**
 * E2E seam (`?demoslow=<ms>`, the same family as `?demoreq` / `?webllm=1`): pace each
 * demo round trip so a real browser can observe a build IN FLIGHT. The scripted turns
 * otherwise settle in ~15 ms — faster than any navigation — which makes "the build kept
 * running while I was on another page" unprovable in Playwright (TASK-20260903 AC10).
 * Read ONCE when the adapter is built, so a turn started on `/build?demoslow=…` keeps its
 * pace after the page navigates away (the flag is not in the URL any more by then).
 * Capped so a typo cannot park the demo forever; absent or invalid → no pacing at all.
 */
export const DEMO_SLOW_MAX_MS = 10_000;

export function demoSlowMs(search: string = typeof window === 'undefined' ? '' : window.location.search): number {
  try {
    const raw = new URLSearchParams(search).get('demoslow');
    if (raw === null) return 0;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), DEMO_SLOW_MAX_MS) : 0;
  } catch {
    return 0;
  }
}

export function paced(adapter: AgentAdapter, ms: number): AgentAdapter {
  if (ms <= 0) return adapter;
  return {
    async complete(request) {
      // The wait honours the turn's abort: a stopped or deleted paced demo build must
      // not go on executing scripted tool calls for seconds after the user said stop.
      await new Promise<void>((resolve, reject) => {
        const signal = request.signal;
        if (signal?.aborted === true) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        function onAbort(): void {
          clearTimeout(timer);
          reject(new DOMException('aborted', 'AbortError'));
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return adapter.complete(request);
    },
  };
}

// @snugprotocol/adapters — provider adapters (anthropic/openai/mock), the shared agent
// loop (the single choke point through which providers are called), the tolerant SSE
// parser, and the runner AgentTransport HTTP client. Browser-safe: fetch + Web Streams
// only — the BYOK playground imports this directly.

export type {
  AdapterError,
  AdapterMessage,
  AdapterRequest,
  AdapterResult,
  AgentAdapter,
  FetchLike,
  TokenUsage,
  ToolCall,
  ToolDef,
} from './types.js';

export { mockAdapter, type MockTurn } from './mock.js';

export { ANTHROPIC_DEFAULT_MODEL, anthropicAdapter, type AnthropicAdapterOptions } from './anthropic.js';

export { OPENAI_DEFAULT_MODEL, openaiAdapter, type OpenAiAdapterOptions } from './openai.js';

export {
  POPULAR_MODELS,
  popularModelsFor,
  type CatalogProvider,
  type PopularModel,
} from './model-catalog.js';

export { LOCAL_DEFAULT_BASE_URL, localAdapter, type LocalAdapterOptions } from './local.js';

export { parseSse, tryParseJsonRecord, type SseEvent } from './sse.js';

export {
  createHttpTransport,
  type HttpTransport,
  type HttpTransportOptions,
  type HttpTransportResult,
  type HttpTransportSendOptions,
} from './http-transport.js';

export {
  DEFAULT_MAX_ITERATIONS,
  runAgentTurn,
  type AgentRoundTrip,
  type AgentRoundTripStart,
  type AgentTool,
  type AgentTurnEvent,
  type AgentTurnResult,
  type RunAgentTurnOptions,
} from './agent-turn.js';

export { STREAM_DROPPED_CODE } from './errors.js';

// TASK-20261023-siwc-chatgpt-plan L0 — the ChatGPT-plan seam (ADR-0078 §3/§5, plan §2): the
// Responses adapter (L2) is built against `BearerSource`, never a key; the four host-level
// codes are the named results apps classify as HOST_ERROR honouring `retryable` (R5).
// `isModelId` moves here from the host runner so the playground's settings boundary can
// validate a model id (C5) without a Node-only import.
export {
  CHATGPT_ERROR_CODES,
  type BearerFailureCode,
  type BearerResult,
  type BearerSource,
  type ChatgptErrorCode,
} from './bearer-source.js';

export { MODEL_ID_PATTERN, isModelId } from './model-id.js';

// TASK-20261023-siwc-chatgpt-plan L2 — the Responses adapter on the ChatGPT plan (D3): built
// against `BearerSource`, base pinned, a stream decided by status, named results with fixed
// sentences, and a client-side output ceiling because the route rejects `max_output_tokens`.
export {
  RESPONSES_DEFAULT_BASE_URL,
  RESPONSES_DEFAULT_MAX_TOKENS,
  openaiResponsesAdapter,
  type OpenAiResponsesAdapterOptions,
} from './openai-responses.js';

export { CHATGPT_ERROR_SENTENCES, ERROR_DETAIL_CAP, redactThenCap } from './errors.js';

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
  ToolCall,
  ToolDef,
} from './types.js';

export { mockAdapter, type MockTurn } from './mock.js';

export { ANTHROPIC_DEFAULT_MODEL, anthropicAdapter, type AnthropicAdapterOptions } from './anthropic.js';

export { OPENAI_DEFAULT_MODEL, openaiAdapter, type OpenAiAdapterOptions } from './openai.js';

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
  type AgentTool,
  type AgentTurnEvent,
  type AgentTurnResult,
  type RunAgentTurnOptions,
} from './agent-turn.js';

export { STREAM_DROPPED_CODE } from './errors.js';

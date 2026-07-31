// config.ts — env-derived server configuration. Secrets live HERE and only here (C5):
// packages never read env; adapters receive keys through this config at boot.

import { z } from 'zod';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HEARTBEAT_MS = 15_000;
/** Thread history cap: the last N messages are sent to the model on the chat path. */
export const HISTORY_CAP = 40;

const adapterName = z.enum(['mock', 'anthropic', 'openai']);
export type AdapterName = z.infer<typeof adapterName>;

export interface RateLimitConfig {
  /** Token-bucket capacity per client IP (generous default — this is a simple cap, not auth). */
  capacity: number;
  refillPerSecond: number;
}

export interface ServerConfig {
  adapter: AdapterName;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Optional model override; adapters fall back to their own defaults. */
  model?: string;
  port: number;
  host: string;
  /** CORS origin for the playground; `true` reflects any origin (single-user OSS reference). */
  corsOrigin: string | boolean;
  /** Directory for SQLite files, or ':memory:' for tests. */
  dataDir: string;
  /** SSE heartbeat interval; tests override with a short value. */
  heartbeatMs: number;
  rateLimit: RateLimitConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsedAdapter = adapterName.safeParse(env.SNUG_ADAPTER ?? 'mock');
  if (!parsedAdapter.success) {
    throw new Error(`SNUG_ADAPTER must be one of mock|anthropic|openai, got "${env.SNUG_ADAPTER}"`);
  }
  const adapter = parsedAdapter.data;
  if (adapter === 'anthropic' && (env.ANTHROPIC_API_KEY ?? '') === '') {
    throw new Error('SNUG_ADAPTER=anthropic requires ANTHROPIC_API_KEY');
  }
  if (adapter === 'openai' && (env.OPENAI_API_KEY ?? '') === '') {
    throw new Error('SNUG_ADAPTER=openai requires OPENAI_API_KEY');
  }
  return {
    adapter,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    model: env.SNUG_MODEL,
    port: intFromEnv(env.PORT, DEFAULT_PORT),
    host: env.HOST ?? '127.0.0.1',
    corsOrigin: env.SNUG_CORS_ORIGIN ?? true,
    dataDir: env.SNUG_DATA_DIR ?? './data',
    heartbeatMs: intFromEnv(env.SNUG_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
    rateLimit: {
      capacity: intFromEnv(env.SNUG_RATE_CAPACITY, 60),
      refillPerSecond: numberFromEnv(env.SNUG_RATE_REFILL_PER_SECOND, 1),
    },
  };
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 0) throw new Error(`invalid numeric env value "${raw}"`);
  return value;
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isNaN(value) || value < 0) throw new Error(`invalid numeric env value "${raw}"`);
  return value;
}

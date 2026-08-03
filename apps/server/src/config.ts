// config.ts — env-derived server configuration. Secrets live HERE and only here (C5):
// packages never read env; adapters receive keys through this config at boot.
//
// Empty-env-var rule (2026-08-02 lesson): '' is UNSET for every string var with a
// fallback — `stringFromEnv` (the `value || fallback` pattern), never bare `??`.
// A `SNUG_MODEL=` line in an env file must select the default, not the empty string.

import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HEARTBEAT_MS = 15_000;
/** Thread history cap: the last N messages are sent to the model on the chat path. */
export const HISTORY_CAP = 40;

/** Google's issuer identifier; tests point this at a local fake issuer. */
export const DEFAULT_OIDC_ISSUER = 'https://accounts.google.com';
/** Session signing keys shorter than this are refused at boot (fail closed, F18). */
export const MIN_SESSION_SECRET_CHARS = 32;

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
  /**
   * CORS origin for the playground; `true` reflects any origin (single-user OSS
   * reference, auth disabled ONLY). With auth enabled this is always an explicit
   * origin string — loadConfig fails the boot otherwise (F2 fail-closed).
   */
  corsOrigin: string | boolean;
  /** Directory for SQLite files, or ':memory:' for tests. */
  dataDir: string;
  /** SSE heartbeat interval; tests override with a short value. */
  heartbeatMs: number;
  rateLimit: RateLimitConfig;
  /** True when SNUG_AUTH=google — enables /auth/*, /userdb, cookies, credentialed CORS. */
  authEnabled: boolean;
  /** OIDC issuer identifier; injectable so tests run against a local fake issuer. */
  oidcIssuer: string;
  googleClientId?: string;
  googleClientSecret?: string;
  /** HMAC key for session/state cookies; required (boot failure) whenever auth is enabled. */
  sessionSecret?: string;
  /** Built playground directory, served at / when it exists (dev: absent, skipped). */
  staticDir: string;
}

/** Default static root: apps/playground/dist, resolved relative to this file (src/ and dist/ sit at the same depth). */
export function defaultStaticDir(): string {
  return fileURLToPath(new URL('../../playground/dist', import.meta.url));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsedAdapter = adapterName.safeParse(stringFromEnv(env.SNUG_ADAPTER, 'mock'));
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

  const auth = stringFromEnv(env.SNUG_AUTH, undefined);
  if (auth !== undefined && auth !== 'google') {
    throw new Error(`SNUG_AUTH must be unset or "google", got "${auth}" — refusing to boot with auth silently off`);
  }
  const authEnabled = auth === 'google';
  const corsOrigin: string | boolean = stringFromEnv(env.SNUG_CORS_ORIGIN, undefined) ?? true;
  const sessionSecret = stringFromEnv(env.SNUG_SESSION_SECRET, undefined);
  const googleClientId = stringFromEnv(env.SNUG_GOOGLE_CLIENT_ID, undefined);
  const googleClientSecret = stringFromEnv(env.SNUG_GOOGLE_CLIENT_SECRET, undefined);

  if (authEnabled) {
    // Fail closed (F2/F18): a hub with auth on never boots half-configured.
    if (sessionSecret === undefined) {
      throw new Error('SNUG_AUTH=google requires SNUG_SESSION_SECRET (a long random string; empty counts as unset)');
    }
    if (sessionSecret.length < MIN_SESSION_SECRET_CHARS) {
      throw new Error(`SNUG_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_CHARS} characters — use a real random key`);
    }
    if (googleClientId === undefined) {
      throw new Error('SNUG_AUTH=google requires SNUG_GOOGLE_CLIENT_ID');
    }
    if (googleClientSecret === undefined) {
      throw new Error('SNUG_AUTH=google requires SNUG_GOOGLE_CLIENT_SECRET');
    }
    if (typeof corsOrigin !== 'string' || corsOrigin === '*') {
      throw new Error(
        'SNUG_AUTH=google requires an explicit SNUG_CORS_ORIGIN (e.g. https://hub.example.com) — ' +
          'reflect-any CORS with credentialed cookies is refused (fail closed)',
      );
    }
  }

  return {
    adapter,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    model: stringFromEnv(env.SNUG_MODEL, undefined),
    port: intFromEnv(env.PORT, DEFAULT_PORT),
    host: stringFromEnv(env.HOST, '127.0.0.1'),
    corsOrigin,
    dataDir: stringFromEnv(env.SNUG_DATA_DIR, './data'),
    heartbeatMs: intFromEnv(env.SNUG_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
    rateLimit: {
      capacity: intFromEnv(env.SNUG_RATE_CAPACITY, 60),
      refillPerSecond: numberFromEnv(env.SNUG_RATE_REFILL_PER_SECOND, 1),
    },
    authEnabled,
    oidcIssuer: stringFromEnv(env.SNUG_OIDC_ISSUER, DEFAULT_OIDC_ISSUER),
    googleClientId,
    googleClientSecret,
    sessionSecret,
    staticDir: stringFromEnv(env.SNUG_STATIC_DIR, undefined) ?? defaultStaticDir(),
  };
}

/** `'' || fallback` — empty string is unset (2026-08-02 lesson). */
function stringFromEnv(raw: string | undefined, fallback: string): string;
function stringFromEnv(raw: string | undefined, fallback: string | undefined): string | undefined;
function stringFromEnv(raw: string | undefined, fallback: string | undefined): string | undefined {
  return raw !== undefined && raw !== '' ? raw : fallback;
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

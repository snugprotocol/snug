// app.ts — build the Fastify instance (separated from listen() for injection tests).

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import cors from '@fastify/cors';
import type { AgentAdapter } from '@snugprotocol/adapters';
import Fastify, { type FastifyInstance } from 'fastify';

import { createAdapterFromConfig } from './adapter.js';
import type { ServerConfig } from './config.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerInvokeRoute } from './routes/invoke.js';
import { createArtifactStore, type ArtifactStore } from './stores/artifacts.js';
import { createThreadStore, type ThreadStore } from './stores/threads.js';

/**
 * Explicit /invoke body cap (never rely on Fastify's implicit default): room for a
 * MAX_FRAME_BYTES envelope (256 KiB) plus generous chat prose — artifacts never travel
 * inbound, so nothing legitimate approaches this.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface AppOptions {
  config: ServerConfig;
  /** Test seams — defaults are built from config. */
  adapter?: AgentAdapter;
  artifactStore?: ArtifactStore;
  threadStore?: ThreadStore;
  rateLimiter?: RateLimiter;
  logger?: boolean;
}

function dbPath(dataDir: string, file: string): string {
  if (dataDir === ':memory:') return ':memory:';
  mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, file);
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_BODY_BYTES });
  await app.register(cors, { origin: config.corsOrigin });

  const artifacts = options.artifactStore ?? createArtifactStore(dbPath(config.dataDir, 'artifacts.sqlite'));
  const threads = options.threadStore ?? createThreadStore(dbPath(config.dataDir, 'threads.sqlite'));
  const adapter = options.adapter ?? createAdapterFromConfig(config);
  const rateLimiter = options.rateLimiter ?? createRateLimiter(config.rateLimit);

  registerInvokeRoute(app, { adapter, artifacts, threads, heartbeatMs: config.heartbeatMs, rateLimiter });
  registerArtifactRoutes(app, artifacts);

  app.addHook('onClose', async () => {
    artifacts.close();
    threads.close();
  });

  return app;
}

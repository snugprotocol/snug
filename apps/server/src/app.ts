// app.ts — build the Fastify instance (separated from listen() for injection tests).
// Auth-disabled (default) is byte-for-byte v1: no cookie plugin, no /auth/*, no
// /userdb, CORS exactly as before. SNUG_AUTH=google flips on the multi-tenant hub
// surface with fail-closed CORS (explicit origin + credentials) — config.ts already
// refused to boot otherwise. Static hosting of the built playground registers LAST so
// API routes always win, and only when the dist directory actually exists (dev: absent).

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import fastifyCookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { AgentAdapter } from '@snugprotocol/adapters';
import Fastify, { type FastifyInstance } from 'fastify';

import { createAdapterFromConfig } from './adapter.js';
import { createOidcClient, type OidcClient } from './auth/oidc.js';
import type { ServerConfig } from './config.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerInvokeRoute } from './routes/invoke.js';
import { registerUserDbRoutes } from './routes/userdb.js';
import { createArtifactStore, type ArtifactStore } from './stores/artifacts.js';
import { createThreadStore, type ThreadStore } from './stores/threads.js';
import { createUserDbStore, type UserDbStore } from './stores/userdbs.js';
import { createUserStore, type UserStore } from './stores/users.js';

/**
 * Explicit /invoke body cap (never rely on Fastify's implicit default): room for a
 * MAX_FRAME_BYTES envelope (256 KiB) plus generous chat prose — artifacts never travel
 * inbound, so nothing legitimate approaches this. PUT /userdb overrides this with its
 * own route-scoped limit just above the user-DB quota.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Namespaces the SPA fallback must never swallow (API contract stays JSON). */
const API_PREFIXES = ['/invoke', '/artifacts', '/auth', '/userdb'];

export interface AppOptions {
  config: ServerConfig;
  /** Test seams — defaults are built from config. */
  adapter?: AgentAdapter;
  artifactStore?: ArtifactStore;
  threadStore?: ThreadStore;
  rateLimiter?: RateLimiter;
  userStore?: UserStore;
  userDbStore?: UserDbStore;
  oidcClient?: OidcClient;
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
  if (config.authEnabled) {
    // Credentialed CORS is only ever paired with the explicit origin (F2 fail-closed;
    // loadConfig guarantees corsOrigin is a concrete string when auth is enabled).
    // The array form makes @fastify/cors COMPARE against the request Origin — a
    // non-matching origin gets no ACAO header at all (a bare string is emitted
    // unconditionally, which would hand every origin a plausible-looking header).
    await app.register(cors, { origin: [config.corsOrigin as string], credentials: true });
  } else {
    await app.register(cors, { origin: config.corsOrigin });
  }

  const artifacts = options.artifactStore ?? createArtifactStore(dbPath(config.dataDir, 'artifacts.sqlite'));
  const threads = options.threadStore ?? createThreadStore(dbPath(config.dataDir, 'threads.sqlite'));
  const adapter = options.adapter ?? createAdapterFromConfig(config);
  const rateLimiter = options.rateLimiter ?? createRateLimiter(config.rateLimit);

  registerInvokeRoute(app, { adapter, artifacts, threads, heartbeatMs: config.heartbeatMs, rateLimiter });
  registerArtifactRoutes(app, artifacts);

  let users: UserStore | undefined;
  let userdbs: UserDbStore | undefined;
  if (config.authEnabled) {
    const sessionSecret = config.sessionSecret;
    const clientId = config.googleClientId;
    const clientSecret = config.googleClientSecret;
    if (sessionSecret === undefined || clientId === undefined || clientSecret === undefined) {
      // loadConfig fails closed before this point; guard against hand-built configs.
      throw new Error('auth enabled without sessionSecret/googleClientId/googleClientSecret');
    }
    await app.register(fastifyCookie);
    // PUT /userdb ships raw bytes; parse octet-stream bodies as Buffers (route bodyLimit applies).
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    users = options.userStore ?? createUserStore(dbPath(config.dataDir, 'users.sqlite'));
    userdbs = options.userDbStore ?? createUserDbStore(dbPath(config.dataDir, 'userdbs.sqlite'));
    const oidc =
      options.oidcClient ?? createOidcClient({ issuer: config.oidcIssuer, clientId, clientSecret });
    registerAuthRoutes(app, { oidc, users, sessionSecret });
    registerUserDbRoutes(app, { userdbs, sessionSecret });
  }

  registerStaticHosting(app, config.staticDir);

  app.addHook('onClose', async () => {
    artifacts.close();
    threads.close();
    users?.close();
    userdbs?.close();
  });

  return app;
}

/** Serve the built playground when it exists; SPA fallback everywhere except the API namespaces. */
function registerStaticHosting(app: FastifyInstance, staticDir: string): void {
  if (staticDir === '' || !existsSync(path.join(staticDir, 'index.html'))) return;
  void app.register(fastifyStatic, { root: path.resolve(staticDir) });
  app.setNotFoundHandler((request, reply) => {
    const urlPath = (request.raw.url ?? '').split('?')[0] ?? '';
    const isApi = API_PREFIXES.some((prefix) => urlPath === prefix || urlPath.startsWith(`${prefix}/`));
    if (request.method === 'GET' && !isApi) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.status(404).send({ code: 'NOT_FOUND', message: 'no such route', retryable: false });
  });
}

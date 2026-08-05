// routes/userdb.ts — per-user portable DB sync endpoints (AC14 fail-closed surface).
// GET: session-authed, exact bytes, octet-stream + nosniff + no-store + etag (F19).
// PUT: session + CSRF double-submit, application/octet-stream only, SQLite magic-byte
// check, and optimistic concurrency: If-Match must equal the stored revision (412 +
// current etag otherwise); the FIRST write must assert If-None-Match: * (a bare PUT
// is 428) so a client that lost its revision can never blind-overwrite. Route-scoped
// bodyLimit sits just above the quota so oversized pushes die at the parser.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { checkCsrf, readSession, type SessionInfo } from '../auth/session.js';
import type { RateLimiter } from '../rate-limit.js';
import type { UserDbStore } from '../stores/userdbs.js';

/** First 16 bytes of every SQLite database file: 'SQLite format 3\0'. */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
/** Headroom above the quota so a quota-sized body reaches the store's typed 413, not the parser's. */
export const BODY_LIMIT_HEADROOM = 64 * 1024;

export interface UserDbRouteDeps {
  userdbs: UserDbStore;
  sessionSecret: string;
  /** Optional per-IP throttle (umbrella review minor 5) — absent in unit tests. */
  rateLimiter?: RateLimiter;
}

export function registerUserDbRoutes(app: FastifyInstance, deps: UserDbRouteDeps): void {
  const { userdbs, sessionSecret, rateLimiter } = deps;

  const throttled = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (rateLimiter !== undefined && !rateLimiter.take(request.ip)) {
      void reply.status(429).send({ code: 'RATE_LIMITED', message: 'too many requests — slow down and retry', retryable: true });
      return true;
    }
    return false;
  };

  const requireSession = (request: FastifyRequest, reply: FastifyReply): SessionInfo | undefined => {
    const session = readSession(request, sessionSecret);
    if (session === undefined) {
      void reply.status(401).send({ code: 'UNAUTHENTICATED', message: 'no valid session', retryable: false });
      return undefined;
    }
    return session;
  };

  app.get('/userdb', async (request, reply) => {
    if (throttled(request, reply)) return reply;
    const session = requireSession(request, reply);
    if (session === undefined) return reply;
    const record = userdbs.get(session.userId);
    if (record === undefined) {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'no user DB pushed yet', retryable: false });
    }
    return reply
      .headers({
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        etag: record.revision,
      })
      .send(record.bytes);
  });

  app.put(
    '/userdb',
    { bodyLimit: userdbs.maxBytes + BODY_LIMIT_HEADROOM },
    async (request, reply) => {
      if (throttled(request, reply)) return reply;
      const session = requireSession(request, reply);
      if (session === undefined) return reply;
      if (!checkCsrf(request)) {
        return reply.status(403).send({
          code: 'CSRF_REJECTED',
          message: 'PUT /userdb requires the x-snug-csrf header matching the snug_csrf cookie',
          retryable: false,
        });
      }
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.startsWith('application/octet-stream') || !Buffer.isBuffer(request.body)) {
        return reply.status(415).send({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'user DB uploads must be application/octet-stream',
          retryable: false,
        });
      }
      const bytes = request.body;
      if (bytes.byteLength < SQLITE_MAGIC.length || !bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
        return reply.status(400).send({
          code: 'NOT_SQLITE',
          message: 'body is not a SQLite database (magic bytes missing)',
          retryable: false,
        });
      }

      const ifMatch = normalizeEtag(request.headers['if-match']);
      const ifNoneMatch = normalizeEtag(request.headers['if-none-match']);
      if (ifMatch === undefined && ifNoneMatch !== '*') {
        return reply.status(428).send({
          code: 'PRECONDITION_REQUIRED',
          message: 'PUT /userdb requires If-Match: <revision> (or If-None-Match: * for the first write)',
          retryable: false,
        });
      }

      const result = userdbs.put(session.userId, bytes, ifMatch);
      if (!result.ok) {
        if (result.code === 'USERDB_TOO_LARGE') {
          return reply.status(413).send({ code: result.code, message: result.message, retryable: false });
        }
        // The conflict contract is machine-readable in BOTH places (AC22): the etag header
        // and a body `revision`, so a client that can read only one still agrees with us.
        // When no row exists there is no revision — say nothing rather than invent one;
        // the client reads the absence as "the origin is empty" and surfaces divergence.
        if (result.current !== undefined) void reply.header('etag', result.current);
        return reply.status(412).send({
          code: result.code,
          message: result.message,
          retryable: true,
          ...(result.current !== undefined ? { revision: result.current } : {}),
        });
      }
      return reply.status(204).header('etag', result.revision).send();
    },
  );
}

/** ETags may arrive quoted per RFC 9110; revisions are opaque tokens, so strip quotes. */
function normalizeEtag(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw[0] ?? '' : raw).trim();
  if (value === '') return undefined;
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
}

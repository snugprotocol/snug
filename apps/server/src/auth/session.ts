// auth/session.ts — HMAC-signed cookie sessions + CSRF double-submit (node:crypto,
// no crypto dep). Cookie value = base64url(JSON payload) + '.' + base64url(HMAC-SHA256).
// Every payload carries `exp` (ms epoch) and is refused after it. Verification is
// constant-time on the tag. Secure flag: omitted ONLY for plain-http localhost dev —
// any other host gets Secure even before TLS is in front (fail-closed direction: a
// misdeployed http hub breaks login instead of leaking session cookies).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const SESSION_COOKIE = 'snug_session';
export const CSRF_COOKIE = 'snug_csrf';
/** One-shot login state cookie (PKCE verifier + state), scoped to /auth. */
export const OIDC_COOKIE = 'snug_oidc';
export const CSRF_HEADER = 'x-snug-csrf';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;

const signedPayload = z.looseObject({ exp: z.number() });

export function signPayload(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

/** Returns the payload when the tag verifies and `exp` is in the future; undefined otherwise. */
export function verifyPayload(value: string | undefined, secret: string): Record<string, unknown> | undefined {
  if (value === undefined || value === '') return undefined;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = value.slice(0, dot);
  const tag = value.slice(dot + 1);
  const expected = hmac(body, secret);
  const tagBytes = Buffer.from(tag);
  const expectedBytes = Buffer.from(expected);
  if (tagBytes.length !== expectedBytes.length || !timingSafeEqual(tagBytes, expectedBytes)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const checked = signedPayload.safeParse(parsed);
  if (!checked.success || checked.data.exp <= Date.now()) return undefined;
  return checked.data;
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Secure flag policy: only plain-http on localhost may omit it (dev ergonomics). */
export function isSecureRequest(request: FastifyRequest): boolean {
  if (request.protocol === 'https') return true;
  return !LOCAL_HOSTNAMES.has(request.hostname.toLowerCase());
}

const sessionPayload = z.looseObject({ userId: z.string().min(1), exp: z.number() });

export interface SessionInfo {
  userId: string;
}

/** Read + verify the session cookie; undefined = unauthenticated. */
export function readSession(request: FastifyRequest, secret: string): SessionInfo | undefined {
  const verified = verifyPayload(request.cookies[SESSION_COOKIE], secret);
  if (verified === undefined) return undefined;
  const parsed = sessionPayload.safeParse(verified);
  return parsed.success ? { userId: parsed.data.userId } : undefined;
}

/** CSRF double-submit: the mutating request must echo the csrf cookie in the header. */
export function checkCsrf(request: FastifyRequest): boolean {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  if (cookie === undefined || cookie === '' || typeof header !== 'string' || header === '') return false;
  const cookieBytes = Buffer.from(cookie);
  const headerBytes = Buffer.from(header);
  return cookieBytes.length === headerBytes.length && timingSafeEqual(cookieBytes, headerBytes);
}

export function setSessionCookies(reply: FastifyReply, request: FastifyRequest, userId: string, secret: string): void {
  const secure = isSecureRequest(request);
  const value = signPayload({ userId, exp: Date.now() + SESSION_TTL_MS }, secret);
  reply.setCookie(SESSION_COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  // Deliberately NOT httpOnly: the client reads it to echo the x-snug-csrf header.
  reply.setCookie(CSRF_COOKIE, newCsrfToken(), {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookies(reply: FastifyReply, request: FastifyRequest): void {
  const secure = isSecureRequest(request);
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure });
  reply.clearCookie(CSRF_COOKIE, { path: '/', httpOnly: false, sameSite: 'lax', secure });
}

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

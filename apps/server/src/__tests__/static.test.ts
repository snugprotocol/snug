// AC6 (hub-sso): static hosting of the built playground — index.html at /, assets
// served, SPA fallback for client-side routes, but NEVER for the API namespaces
// (/invoke, /artifacts, /auth, /userdb). Cleanly absent when dist does not exist.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { authTestConfig, buildTestApp, testConfig } from './helpers.js';

let app: FastifyInstance | undefined;
let distDir: string;

const INDEX_HTML = '<!doctype html><html><head><title>Snug Playground</title></head><body>spa-root</body></html>';

beforeAll(() => {
  distDir = mkdtempSync(path.join(tmpdir(), 'snug-static-'));
  writeFileSync(path.join(distDir, 'index.html'), INDEX_HTML);
  mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("snug");');
});
afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('static hosting (AC6)', () => {
  it('serves index.html at / when the dist dir exists', async () => {
    app = await buildTestApp({ config: testConfig({ staticDir: distDir }) });
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.payload).toBe(INDEX_HTML);
  });

  it('serves static assets', async () => {
    app = await buildTestApp({ config: testConfig({ staticDir: distDir }) });
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('snug');
  });

  it('falls back to index.html for SPA paths', async () => {
    app = await buildTestApp({ config: testConfig({ staticDir: distDir }) });
    const response = await app.inject({ method: 'GET', url: '/apps/some-app/settings' });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe(INDEX_HTML);
  });

  it('never swallows the API namespaces with the SPA fallback', async () => {
    app = await buildTestApp({ config: testConfig({ staticDir: distDir }) });
    for (const url of ['/invoke', '/userdb', '/auth/login', '/auth/me']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers['content-type'], url).toContain('application/json');
    }
    // Registered API routes keep their own handlers and typed errors.
    const missingArtifact = await app.inject({ method: 'GET', url: '/artifacts/nope' });
    expect(missingArtifact.statusCode).toBe(404);
    expect(missingArtifact.json()).toMatchObject({ code: 'NOT_FOUND' });
    const list = await app.inject({ method: 'GET', url: '/artifacts' });
    expect(list.statusCode).toBe(200);
  });

  it('auth routes win over static when auth is enabled (401 JSON, not index.html)', async () => {
    app = await buildTestApp({ config: authTestConfig({ staticDir: distDir }) });
    const response = await app.inject({ method: 'GET', url: '/userdb' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('is cleanly absent when the dist dir does not exist (dev)', async () => {
    app = await buildTestApp({ config: testConfig({ staticDir: '/nonexistent/snug-playground-dist' }) });
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(404);
    const spa = await app.inject({ method: 'GET', url: '/apps/some-app' });
    expect(spa.statusCode).toBe(404);
  });
});

// AC5 (hub-sso): fail-closed boot — SNUG_AUTH=google refuses to start without an
// explicit session secret, Google client credentials, and a concrete CORS origin
// (no reflect-any with credentialed cookies). Plus the 2026-08-02 lesson: '' env
// values are treated as unset everywhere, never silently adopted.

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';

const AUTH_ENV: Record<string, string> = {
  SNUG_AUTH: 'google',
  SNUG_SESSION_SECRET: 's'.repeat(48),
  SNUG_GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  SNUG_GOOGLE_CLIENT_SECRET: 'client-secret',
  SNUG_CORS_ORIGIN: 'https://hub.example.com',
};

function withAuthEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...AUTH_ENV, ...overrides };
}

describe('auth-enabled boot validation (AC5)', () => {
  it('boots with the full auth env and exposes the auth config', () => {
    const config = loadConfig(AUTH_ENV);
    expect(config.authEnabled).toBe(true);
    expect(config.googleClientId).toBe(AUTH_ENV.SNUG_GOOGLE_CLIENT_ID);
    expect(config.googleClientSecret).toBe(AUTH_ENV.SNUG_GOOGLE_CLIENT_SECRET);
    expect(config.sessionSecret).toBe(AUTH_ENV.SNUG_SESSION_SECRET);
    expect(config.corsOrigin).toBe('https://hub.example.com');
    expect(config.oidcIssuer).toBe('https://accounts.google.com');
  });

  it.each([
    ['SNUG_SESSION_SECRET', /SNUG_SESSION_SECRET/],
    ['SNUG_GOOGLE_CLIENT_ID', /SNUG_GOOGLE_CLIENT_ID/],
    ['SNUG_GOOGLE_CLIENT_SECRET', /SNUG_GOOGLE_CLIENT_SECRET/],
    ['SNUG_CORS_ORIGIN', /SNUG_CORS_ORIGIN/],
  ])('fails boot when %s is missing', (name, message) => {
    expect(() => loadConfig(withAuthEnv({ [name]: undefined }))).toThrow(message);
  });

  it.each([
    ['SNUG_SESSION_SECRET'],
    ['SNUG_GOOGLE_CLIENT_ID'],
    ['SNUG_GOOGLE_CLIENT_SECRET'],
    ['SNUG_CORS_ORIGIN'],
  ])('fails boot when %s is present but empty (empty string is unset)', (name) => {
    expect(() => loadConfig(withAuthEnv({ [name]: '' }))).toThrow(new RegExp(name));
  });

  it('refuses reflect-any CORS when auth is enabled (no SNUG_CORS_ORIGIN, and "*")', () => {
    expect(() => loadConfig(withAuthEnv({ SNUG_CORS_ORIGIN: undefined }))).toThrow(/SNUG_CORS_ORIGIN/);
    expect(() => loadConfig(withAuthEnv({ SNUG_CORS_ORIGIN: '*' }))).toThrow(/SNUG_CORS_ORIGIN/);
  });

  it('refuses a session secret too short to be a real key', () => {
    expect(() => loadConfig(withAuthEnv({ SNUG_SESSION_SECRET: 'short' }))).toThrow(/SNUG_SESSION_SECRET/);
  });

  it('honors SNUG_OIDC_ISSUER, treating empty as unset', () => {
    expect(loadConfig(withAuthEnv({ SNUG_OIDC_ISSUER: 'http://127.0.0.1:9999' })).oidcIssuer).toBe(
      'http://127.0.0.1:9999',
    );
    expect(loadConfig(withAuthEnv({ SNUG_OIDC_ISSUER: '' })).oidcIssuer).toBe('https://accounts.google.com');
  });

  it('rejects an unknown SNUG_AUTH value instead of silently disabling auth', () => {
    expect(() => loadConfig({ SNUG_AUTH: 'okta' })).toThrow(/SNUG_AUTH/);
  });
});

describe('auth-disabled default (v1 behavior preserved)', () => {
  it('is disabled with no SNUG_AUTH, and with SNUG_AUTH= empty', () => {
    expect(loadConfig({}).authEnabled).toBe(false);
    expect(loadConfig({ SNUG_AUTH: '' }).authEnabled).toBe(false);
  });

  it('requires none of the auth vars when disabled', () => {
    const config = loadConfig({});
    expect(config.sessionSecret).toBeUndefined();
    expect(config.googleClientId).toBeUndefined();
    expect(config.corsOrigin).toBe(true);
  });
});

describe("'' treated as unset (2026-08-02 lesson)", () => {
  it('SNUG_CORS_ORIGIN= falls back to reflect-any when auth is disabled', () => {
    expect(loadConfig({ SNUG_CORS_ORIGIN: '' }).corsOrigin).toBe(true);
  });

  it('SNUG_MODEL= falls back to the adapter default (undefined), not the empty string', () => {
    expect(loadConfig({ SNUG_MODEL: '' }).model).toBeUndefined();
    expect(loadConfig({ SNUG_MODEL: 'claude-fable-5' }).model).toBe('claude-fable-5');
  });

  it('SNUG_ADAPTER= falls back to mock', () => {
    expect(loadConfig({ SNUG_ADAPTER: '' }).adapter).toBe('mock');
  });

  it('SNUG_DATA_DIR= and HOST= fall back to their defaults', () => {
    const config = loadConfig({ SNUG_DATA_DIR: '', HOST: '' });
    expect(config.dataDir).toBe('./data');
    expect(config.host).toBe('127.0.0.1');
  });
});

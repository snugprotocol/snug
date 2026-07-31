import { describe, expect, it } from 'vitest';
import { STRIP_HEADERS, scanForCredentialValues, stripCredentialHeaders } from '../index.js';

describe('stripCredentialHeaders (C1 — deterministic MUST)', () => {
  it('strips every listed credential header case-insensitively', () => {
    const input: Record<string, string> = {
      Authorization: 'Bearer abc123',
      COOKIE: 'session=1',
      'set-cookie': 'a=b',
      'X-Api-Key': 'k',
      'Proxy-Authorization': 'Basic Zm9v',
      'content-type': 'application/json',
      accept: '*/*',
    };
    const out = stripCredentialHeaders(input);
    for (const name of STRIP_HEADERS) {
      expect(Object.keys(out).map((k) => k.toLowerCase())).not.toContain(name);
    }
    expect(out['content-type']).toBe('application/json');
    expect(out.accept).toBe('*/*');
  });

  it('does not mutate its input', () => {
    const input = { Authorization: 'Bearer x', ok: 'yes' };
    stripCredentialHeaders(input);
    expect(input.Authorization).toBe('Bearer x');
  });
});

describe('scanForCredentialValues (C1 — value-shape detection, review finding 4)', () => {
  it('rejects a Bearer token planted deep in payload', () => {
    const { rejects } = scanForCredentialValues({ a: { b: [{ c: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }] } });
    expect(rejects.length).toBeGreaterThan(0);
    expect(rejects[0]?.path).toContain('c');
  });

  it('rejects a raw JWT value', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const { rejects } = scanForCredentialValues({ data: jwt });
    expect(rejects.length).toBeGreaterThan(0);
  });

  it('rejects high-entropy secret-looking strings', () => {
    const { rejects } = scanForCredentialValues({ blob: 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD' });
    expect(rejects.length).toBeGreaterThan(0);
  });

  it('does NOT reject a chess app token field ({token: "rook"}) — warns only', () => {
    const { rejects, warnings } = scanForCredentialValues({ token: 'rook', square: 'e4' });
    expect(rejects).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not flag ordinary game state at all', () => {
    const { rejects, warnings } = scanForCredentialValues({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      history: ['e4', 'e5', 'Nf3'],
      score: 12,
    });
    expect(rejects).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('handles cycles and non-object input without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => scanForCredentialValues(cyclic)).not.toThrow();
    expect(() => scanForCredentialValues(null)).not.toThrow();
    expect(() => scanForCredentialValues('Bearer xyzabc123456')).not.toThrow();
  });
});

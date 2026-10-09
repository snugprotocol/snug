// @vitest-environment node
//
// The in-shell net-scope checks (TASK-20261008-p0-clearance W3): their verdict logic is pure
// and pinned here; the checks themselves run inside the shell against the real plugin
// (`pnpm --filter desktop gate`). The failure mode these pin: a gate that reads ANY rejection
// as "refused" — a missing permission or a renamed command would then vouch for the scope.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decideAdmitted, decideRefused, NET_SCOPE_CHECK_IDS, PROBES, SCOPE_REFUSAL } from '../gate/netScope.js';

const refusal = (url: string) => ({ url, error: `${SCOPE_REFUSAL}: ${url}` });

describe('net-scope gate verdicts', () => {
  it('admitted: every URL got a resource id → PASS; one without → FAIL naming it', () => {
    expect(decideAdmitted('x', [{ url: 'a', rid: 1 }, { url: 'b', rid: 2 }]).pass).toBe(true);
    const r = decideAdmitted('x', [{ url: 'a', rid: 1 }, refusal('http://10.0.0.5/')]);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('http://10.0.0.5/');
  });

  it('refused: every URL rejected BY SCOPE → PASS', () => {
    expect(decideRefused('x', [refusal('a'), refusal('b')]).pass).toBe(true);
  });

  it('NEGATIVE: an admitted URL fails the refusal check (the scope is open)', () => {
    const r = decideRefused('x', [refusal('a'), { url: 'http://172.32.0.1/', rid: 7 }]);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/ADMITTED/);
  });

  it('NEGATIVE: a rejection for ANY other reason is "cannot tell", never a pass', () => {
    for (const error of ['command plugin:http|fetch not allowed by ACL', 'command not found', 'invalid args `clientConfig`']) {
      const r = decideRefused('x', [{ url: 'http://11.0.0.1/', error }]);
      expect(r.pass, error).toBe(false);
      expect(r.detail).toMatch(/cannot tell/);
    }
  });

  it('an empty probe list never passes', () => {
    expect(decideAdmitted('x', []).pass).toBe(false);
    expect(decideRefused('x', []).pass).toBe(false);
  });

  it('every check id has probes and every probe set belongs to a check id', () => {
    expect(Object.keys(PROBES).sort()).toEqual([...NET_SCOPE_CHECK_IDS].sort());
    for (const urls of Object.values(PROBES)) expect(urls.length).toBeGreaterThan(0);
  });

  it('no probe names the debug stub — the driver scans the built bundle for that origin', () => {
    const source = readFileSync(fileURLToPath(new URL('../gate/netScope.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/127\.0\.0\.1:43120/);
  });
});

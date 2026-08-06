// AL-03 plan D3.5 — the SSRF guard, honest browser edition: literal private/loopback/
// link-local IPs (v4+v6), `localhost`, `.local`, `.internal` are rejected. A browser
// cannot pre-resolve DNS, so DNS-rebinding to private IPs is NOT claimed defended here
// (the frozen allowlist is the primary wall; AL-11 states the boundary; desktop native
// fetch revisits it). Hostnames arrive URL-canonicalized (hex/octal IPv4 forms already
// normalized to dotted decimal by `new URL()` before this guard runs).
import { describe, expect, it } from 'vitest';
import { isForbiddenNetHost } from '../net-guards.js';

describe('isForbiddenNetHost — forbidden literals', () => {
  it('rejects loopback, RFC1918, link-local, CGN, and reserved IPv4 literals', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1',
      '192.0.2.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isForbiddenNetHost(ip), `${ip} must be blocked`).toBe(true);
    }
  });

  it('rejects private/loopback IPv6 literals (bracketed and bare)', () => {
    for (const ip of ['[::1]', '::1', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[ff02::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]']) {
      expect(isForbiddenNetHost(ip), `${ip} must be blocked`).toBe(true);
    }
  });

  it('rejects localhost and the .local/.internal/.localhost suffixes, trailing-dot tricks included', () => {
    for (const name of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'db.internal', 'a.b.internal.']) {
      expect(isForbiddenNetHost(name), `${name} must be blocked`).toBe(true);
    }
  });

  it('allows ordinary public hostnames and public IPs', () => {
    for (const host of ['api.spotify.com', 'stub.snug.test', 'example.com', '8.8.8.8', '[2001:4860:4860::8888]', 'internal-tools.example.com', 'mylocal.example.com']) {
      expect(isForbiddenNetHost(host), `${host} must be allowed`).toBe(false);
    }
  });

  it('fails closed on malformed IP-looking input', () => {
    expect(isForbiddenNetHost('999.1.1.1')).toBe(true); // IP-shaped but invalid — never fetch it
  });
});

// AL-03 plan D3.5 — the SSRF guard, honest browser edition: literal private/loopback/
// link-local IPs (v4+v6), `localhost`, `.local`, `.internal` are rejected. A browser
// cannot pre-resolve DNS, so DNS-rebinding to private IPs is NOT claimed defended here
// (the frozen allowlist is the primary wall; AL-11 states the boundary; desktop native
// fetch revisits it). Hostnames arrive URL-canonicalized (hex/octal IPv4 forms already
// normalized to dotted decimal by `new URL()` before this guard runs).
import { describe, expect, it } from 'vitest';
import { isForbiddenNetHost, isPrivateRfc1918Ipv4Literal } from '../net-guards.js';

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

// TASK-20260812-desktop-hub-scaffold Decision 6 — the host class the desktop transport
// policy may admit over http. The classifier must be EXACTLY the three RFC-1918 IPv4
// blocks, parsed octet-wise: a regex-shaped check that passed 172.32.x (outside the /12)
// would hand the http admission to a public range.
describe('isPrivateRfc1918Ipv4Literal — the desktop LAN policy host class', () => {
  it('accepts the three RFC-1918 blocks, edges included', () => {
    for (const ip of [
      '10.0.0.0',
      '10.255.255.255',
      '172.16.0.0',
      '172.31.255.255',
      '192.168.0.0',
      '192.168.255.255',
      '192.168.1.5', // the Hue-bridge shape
    ]) {
      expect(isPrivateRfc1918Ipv4Literal(ip), `${ip} must be in the class`).toBe(true);
    }
  });

  it('rejects the octet neighbours just OUTSIDE each block (172.16.0.0/12 boundary correctness)', () => {
    for (const ip of ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0']) {
      expect(isPrivateRfc1918Ipv4Literal(ip), `${ip} must be outside the class`).toBe(false);
    }
  });

  it('NEVER includes loopback, link-local, CGN, or public literals — those keep their own refusals', () => {
    for (const ip of ['127.0.0.1', '169.254.1.1', '169.254.169.254', '100.64.0.1', '8.8.8.8', '0.0.0.0']) {
      expect(isPrivateRfc1918Ipv4Literal(ip), `${ip} must not be in the class`).toBe(false);
    }
  });

  it('NEVER includes names or suffix tricks — DNS-resolved hosts are not literals', () => {
    for (const name of ['localhost', 'foo.local', 'hue.internal', 'bridge.example.com', '192.168.1.5.example.com']) {
      expect(isPrivateRfc1918Ipv4Literal(name), `${name} must not be in the class`).toBe(false);
    }
  });

  it('NEVER includes IPv6 in any form — the policy covers IPv4 literals only (ULA stays refused)', () => {
    for (const ip of ['[fd00::1]', 'fd00::1', '[fc00::1]', '[fe80::1]', '[::ffff:192.168.1.5]', '[::1]']) {
      expect(isPrivateRfc1918Ipv4Literal(ip), `${ip} must not be in the class`).toBe(false);
    }
  });

  it('fails closed on malformed dotted-decimal input', () => {
    for (const ip of ['192.168.1', '192.168.1.1.1', '192.168.1.999', '999.168.0.1', '']) {
      expect(isPrivateRfc1918Ipv4Literal(ip), `${ip} must not be in the class`).toBe(false);
    }
  });

  it('canonical-form hygiene matches the guard (trailing dot stripped, case/space trimmed)', () => {
    expect(isPrivateRfc1918Ipv4Literal('192.168.1.5.')).toBe(true);
    expect(isPrivateRfc1918Ipv4Literal(' 192.168.1.5 ')).toBe(true);
  });
});

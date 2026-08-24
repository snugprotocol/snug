// privateHost.test.ts — TASK-20260823-legal-terms-privacy-eula AC7 (review F7).
//
// TWO predicates over ONE parser, lifted out of ConnectionWizardSheet.tsx:
//   isPrivateNetworkHost — the LAN band's classifier, bytes unchanged: IPv4 LITERALS in
//     RFC-1918 / loopback / link-local ranges, and nothing else. `localhost` is
//     deliberately NOT private here: the LAN band asks "is this a device on your home
//     network", and lanConsentCopy.test.tsx pins that a public NAME never raises it.
//   isLocalEndpointHost — the local-model band's classifier: everything the LAN band
//     calls private PLUS the names and IPv6 forms that mean "this machine" —
//     `localhost`, `*.localhost`, `[::1]`, `0.0.0.0`, fc00::/7, fe80::/10. Without this
//     widening the band would fire on the DEFAULT `http://localhost:11434/v1`, which is
//     the one endpoint that most certainly does not leave the machine.
//
// A guard scoped to the class that produced it would miss every instance of the class
// that motivated it — so both predicates get the lookalike negatives.

import { describe, expect, it } from 'vitest';

import { isLocalEndpointHost, isPrivateNetworkHost, localEndpointHostOf } from '../security/privateHost.js';

describe('isPrivateNetworkHost (the LAN band, unchanged)', () => {
  it.each(['192.168.1.1', '10.0.0.5', '172.16.4.9', '172.31.255.255', '127.0.0.1', '169.254.1.1'])(
    'private: %s',
    (host) => expect(isPrivateNetworkHost(host)).toBe(true),
  );
  it.each(['8.8.8.8', '172.32.0.1', '192.169.1.1', 'api.some-saas.example', '192-168-1-1.attacker.example', 'localhost', '::1', '999.1.1.1'])(
    'not private: %s',
    (host) => expect(isPrivateNetworkHost(host)).toBe(false),
  );
});

describe('isLocalEndpointHost (the local-model band)', () => {
  it.each([
    'localhost',
    'localhost.', // one trailing dot: the DNS-root spelling of the same name
    'LOCALHOST',
    'ollama.localhost',
    '127.0.0.1',
    '127.0.0.1.',
    '127.1.2.3',
    '0.0.0.0',
    '::1',
    '[::1]',
    'fe80::1',
    'fd12:3456::1',
    '192.168.1.20',
    '10.0.0.5',
  ])('local: %s', (host) => expect(isLocalEndpointHost(host)).toBe(true));

  it.each([
    'api.openai.com',
    'my-ollama.example.com',
    '127-0-0-1.example',
    'localhost.attacker.example',
    'notlocalhost',
    'mymac.local', // mDNS — it DOES leave the machine
    '2001:db8::1',
    '8.8.8.8',
  ])('remote: %s', (host) => expect(isLocalEndpointHost(host)).toBe(false));
});

describe('localEndpointHostOf — the URL → host step, never throws', () => {
  it('extracts the host the browser would connect to', () => {
    expect(localEndpointHostOf('http://localhost:11434/v1')).toBe('localhost');
    expect(localEndpointHostOf('https://my-ollama.example.com:8443/v1')).toBe('my-ollama.example.com');
    expect(localEndpointHostOf('http://[::1]:11434/v1')).toBe('[::1]');
  });

  it('returns undefined for an unparsable or empty URL (the band renders nothing)', () => {
    expect(localEndpointHostOf('')).toBeUndefined();
    expect(localEndpointHostOf('not a url')).toBeUndefined();
    expect(localEndpointHostOf('http://')).toBeUndefined();
  });
});

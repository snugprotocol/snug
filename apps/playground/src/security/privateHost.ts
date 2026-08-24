// privateHost.ts — host classifiers for the consent bands (TASK-20260823-legal-terms-privacy-eula
// AC7; lifted from ConnectionWizardSheet.tsx where the LAN band's predicate lived).
//
// TWO predicates over one parser, deliberately NOT one:
//
//   isPrivateNetworkHost — the LAN band's question: "is this a device on your own
//   network?" IPv4 LITERALS in RFC-1918 / loopback / link-local ranges, and nothing
//   else. String-shaped on purpose: `192-168-1-1.attacker.example` is a PUBLIC name and
//   must not raise the band, or the band stops meaning anything (P0 security amendment
//   15; lanConsentCopy.test.tsx). `localhost` is NOT private here — the LAN band is
//   about other machines.
//
//   isLocalEndpointHost — the local-model band's question: "does this endpoint stay on
//   this machine?" Everything the LAN band calls private PLUS the names and IPv6 forms
//   that mean "here": `localhost`, `*.localhost` (RFC 6761), `[::1]`, `0.0.0.0`,
//   fc00::/7, fe80::/10. Without the widening the band would fire on the DEFAULT
//   `http://localhost:11434/v1` (review F7). A LAN address counts as local for THIS
//   band's purpose — the question is whether the traffic leaves the user's own network
//   to a third party, and 192.168.x.x does not. An mDNS `.local` name does leave the
//   machine, so it is remote here (and the band names it, so the user can judge).
//
// Both are WARNING classifiers: nothing here refuses anything. Self-hosted remote
// endpoints are legitimate and growing; the band's job is to make sure the user is
// asked the question rather than shown a URL.

export function isPrivateNetworkHost(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isLocalEndpointHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '') return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0') return true;
  if (isPrivateNetworkHost(h)) return true;
  // IPv6: loopback, unique-local (fc00::/7), link-local (fe80::/10).
  if (h.includes(':')) {
    if (h === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  }
  return false;
}

/**
 * The host a browser would connect to for `url`, or undefined when the URL cannot be
 * parsed — the band then renders nothing rather than guessing (a half-typed URL is the
 * normal state of the field while the user is editing it).
 */
export function localEndpointHostOf(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.host === '' ? undefined : parsed.hostname === '' ? undefined : bracketed(parsed.hostname);
  } catch {
    return undefined;
  }
}

/** `new URL` strips the brackets from an IPv6 hostname; put them back for display. */
function bracketed(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

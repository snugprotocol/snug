/**
 * SSRF guard, honest browser edition (AL-03 plan D3.5) — ported from an ancestor system's SSRF
 * module MINUS the DNS half: a browser cannot pre-resolve hostnames, so DNS-rebinding
 * to private IPs is NOT claimed defended here. What this guard does reject, fail
 * closed, is every LITERAL non-routable target: private/loopback/link-local/reserved
 * IPv4 and IPv6 literals, `localhost` (and `*.localhost`), and the `.local` /
 * `.internal` suffixes. The frozen per-app host allowlist is the primary wall; AL-11's
 * threat model states this boundary; desktop native fetch revisits it with real DNS.
 *
 * Callers pass `new URL(...).hostname`, which already canonicalizes exotic IPv4
 * spellings (hex `0x7f000001`, octal, dword) to dotted decimal — so the table below
 * sees one canonical form. Browser-safe: no node imports (AC5 lint).
 */

/** [baseInt, maskInt] pairs — an ancestor system's IPv4 block table, verbatim. */
const IPV4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
  [0x7f000000, 0xff000000], // 127.0.0.0/8   — loopback
  [0x0a000000, 0xff000000], // 10.0.0.0/8    — RFC 1918
  [0xac100000, 0xfff00000], // 172.16.0.0/12 — RFC 1918
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 — RFC 1918
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 — link-local (cloud metadata lives here)
  [0x00000000, 0xff000000], // 0.0.0.0/8     — "this" network
  [0x64400000, 0xffc00000], // 100.64.0.0/10 — RFC 6598 shared
  [0xc0000000, 0xffffff00], // 192.0.0.0/24  — IETF protocol
  [0xc0000200, 0xffffff00], // 192.0.2.0/24  — TEST-NET-1
  [0xc6336400, 0xffffff00], // 198.51.100.0/24 — TEST-NET-2
  [0xcb007100, 0xffffff00], // 203.0.113.0/24 — TEST-NET-3
  [0xe0000000, 0xf0000000], // 224.0.0.0/4   — multicast
  [0xf0000000, 0xf0000000], // 240.0.0.0/4   — reserved / broadcast
];

const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isForbiddenIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true; // malformed — fail closed
  const num = (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
  return IPV4_BLOCKED.some(([base, mask]) => ((num & mask) >>> 0) === base);
}

/** Expand an IPv6 literal to 8×16-bit groups; handles `::` and IPv4-mapped suffixes. */
function expandIpv6(ip: string): number[] | undefined {
  let normalized = ip;
  const v4Suffix = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (v4Suffix?.[1] !== undefined) {
    const parts = v4Suffix[1].split('.').map(Number);
    if (parts.some((p) => p > 255)) return undefined;
    const hi = (((parts[0]! << 8) | parts[1]!) >>> 0).toString(16);
    const lo = (((parts[2]! << 8) | parts[3]!) >>> 0).toString(16);
    normalized = ip.slice(0, ip.lastIndexOf(v4Suffix[1])) + `${hi}:${lo}`;
  }
  const halves = normalized.split('::');
  let groups: number[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':').map((h) => parseInt(h, 16)) : [];
    const right = halves[1] ? halves[1].split(':').map((h) => parseInt(h, 16)) : [];
    const fill = 8 - left.length - right.length;
    if (fill < 0) return undefined;
    groups = [...left, ...Array<number>(fill).fill(0), ...right];
  } else if (halves.length === 1) {
    groups = normalized.split(':').map((h) => parseInt(h, 16));
  } else {
    return undefined;
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}

function isForbiddenIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (groups === undefined) return true; // malformed literal — fail closed
  const [g0] = groups as [number, ...number[]];
  if (groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1)) return true; // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return isForbiddenIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`); // ::ffff:x.x.x.x
  }
  return false;
}

const FORBIDDEN_NAME_SUFFIXES = ['.local', '.internal', '.localhost'] as const;

/**
 * True when `hostname` (as produced by `new URL().hostname`) is a literal the envelope
 * net capability must never fetch, regardless of the frozen allowlist (defense in
 * depth: an approved ceiling containing `127.0.0.1` is still refused at this gate).
 */
export function isForbiddenNetHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // trailing-dot trick
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // bracketed IPv6
  if (host.length === 0) return true;
  if (host === 'localhost') return true;
  if (FORBIDDEN_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (IPV4_SHAPE.test(host)) return isForbiddenIpv4(host);
  if (host.includes(':')) return isForbiddenIpv6(host);
  return false;
}

/**
 * True when `hostname` is an RFC-1918 private-range IPv4 LITERAL — 10.0.0.0/8,
 * 172.16.0.0/12, or 192.168.0.0/16, octets parsed numerically. This is the EXACT host
 * class the desktop transport policy (TASK-20260812 Decision 6) may admit over http
 * when the host also sits inside a connection's frozen approved ceiling.
 *
 * Deliberately narrower than "not forbidden": loopback (127/8), link-local
 * (169.254/16), CGN, `localhost`, name suffixes, and DNS names of any kind are NEVER
 * in this class — they keep their own refusals regardless of policy. IPv6 is excluded
 * in every form (bracketed, bare, ULA fc00::/7, IPv4-mapped): Hue-class LAN devices
 * are IPv4, so the policy covers IPv4 literals only — IPv6 ULA stays refused until it
 * earns its own group-wise verification. Anything that is not well-formed
 * dotted-decimal returns false, i.e. fails closed toward the https-only refusal.
 */
export function isPrivateRfc1918Ipv4Literal(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // same trailing-dot hygiene as the guard
  if (!IPV4_SHAPE.test(host)) return false; // names, IPv6 (bracketed or bare), empty
  const parts = host.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/**
 * THE SIDECAR HTTP CONTRACT (ADR-0032, TASK-20260816) — internal draft, deliberately NOT
 * in `json-schemas.ts` SOURCES, same publication line as `chat-intent.ts` and
 * `connection-requirement.ts`.
 *
 * WHAT A SIDECAR IS. Some providers authenticate a DEVICE and then keep a live session
 * that a request/response executor cannot host: personal WhatsApp links a companion device
 * by QR scan and thereafter speaks over a persistent socket. That session lives in a local
 * helper process — the sidecar — which holds the provider's key material on its own disk
 * and exposes this small, enumerated HTTP surface over a UNIX-DOMAIN SOCKET.
 *
 * WHY THE LITERALS LIVE HERE. This contract has four consumers across three process
 * boundaries: the Node sidecar that serves it, the Rust command that admits requests to it,
 * the wizard that pairs against it, and the app that reads through it. No single package's
 * test suite can see a disagreement between them, so the literals get ONE home and every
 * consumer imports it (lessons.md 2026-08-03: two surfaces inventing `x-snug-csrf` vs
 * `x-csrf-token` integrated dead-on-arrival).
 *
 * WHY THERE IS NO HOST AND NO PORT IN THIS FILE. The sidecar is a CAPABILITY, not a network
 * host. It listens on a unix socket whose directory the Rust side owns; nothing the webview
 * says can name where it is. That is a deliberate reversal of an earlier draft that gave the
 * sidecar a loopback address and a port: the frozen connection ceiling is host-granular with
 * no port dimension, so `127.0.0.1` in a ceiling would have admitted EVERY loopback port on
 * the user's machine — the container runtime, the local model server, database admin
 * surfaces, another app's sidecar. A socket path that only Rust can name has no such
 * surface, and port squatting becomes unrepresentable rather than merely mitigated.
 */

/** The verbs this transport carries. A pairing exchange writes; everything else reads. */
export type SidecarMethod = 'GET' | 'POST';

/** One route of the contract: a method and a path pattern, matched together, never apart. */
export interface SidecarRoute {
  readonly method: SidecarMethod;
  readonly path: string;
}

/**
 * A placeholder segment — `:jid` (a WhatsApp thread id: `123@g.us`, `123@s.whatsapp.net`)
 * or `:id` (a message id, ADR-0034). Matched as EXACTLY ONE non-empty path segment: a value
 * that could span segments would let `/chats/a/b/messages` masquerade as a thread route,
 * and a value that could be empty would make `/chats//messages` a legal read of nothing.
 * Every placeholder gets the same class — the traversal guard below, not the segment
 * pattern, is what refuses `..`-shaped values.
 */
const PARAM_SEGMENT = '[^/]+';

/**
 * EVERY route the sidecar serves. Closed set: the Node server refuses anything absent from
 * it, and the app-facing subset below is derived from it rather than retyped.
 */
export const SIDECAR_ROUTES: readonly SidecarRoute[] = [
  // --- pairing (WIZARD ONLY — see APP_REACHABLE_SIDECAR_ROUTES) ---
  { method: 'POST', path: '/pair/start' },
  { method: 'GET', path: '/pair/qr' },
  { method: 'GET', path: '/pair/status' },
  // --- the ADR-0025 verify-before-claim read (WIZARD ONLY) ---
  { method: 'GET', path: '/session/status' },
  // --- the deep-delete unlink (TASK-20260821 AC5; WIZARD ONLY) — best-effort provider
  //     logout, then the auth store (session keys, minted token, thread cache) is erased.
  //     Destructive by design, which is exactly why it rides the nonce-guarded prefix. ---
  { method: 'POST', path: '/session/forget' },
  // --- the thread surface (app-reachable) ---
  { method: 'GET', path: '/chats' },
  { method: 'GET', path: '/chats/:jid/history' },
  { method: 'GET', path: '/chats/:jid/messages' },
  { method: 'POST', path: '/chats/:jid/messages' },
  // --- surface v2 (ADR-0034, TASK-20260817-telepath; app-reachable) ---
  // `/events` long-polls a bounded ring of LEAN HINTS ({jid, kind, ts} — no message
  // bodies, no thumbnails): the host pump's doorbell, never a delivery. `?cursor=` is a
  // contract parameter like `?since=`. Media/picture return base64 JSON under the same
  // 1 MiB while-reading transport cap as every other response — the sidecar REFUSES
  // oversized media with a structured answer rather than truncating.
  { method: 'GET', path: '/events' },
  { method: 'GET', path: '/chats/:jid/media/:id' },
  { method: 'GET', path: '/chats/:jid/picture' },
] as const;

/**
 * Route prefixes an APP may never reach, whatever the token it holds.
 *
 * `/pair/` is how a token comes into existence: `GET /pair/status` hands the minted access
 * token back once, on link. An app able to call it could mint itself a credential — and
 * because a machine may run more than one sidecar, an app approved for its own unrelated
 * helper could poll a DIFFERENT app's pairing route and drive the user's WhatsApp. That is
 * a credential boundary crossed without breaking the credential store at all, simply by
 * fetching the credential over the transport.
 *
 * `/session/status` is the wizard's verify seat (ADR-0025): it proves a just-minted key
 * before anything claims connected. Proving the connection is the host's job, not the app's.
 */
const WIZARD_ONLY_PREFIXES = ['/pair/', '/session/'] as const;

/**
 * The subset an app may reach — DERIVED, never a second hand-written list. Two parallel
 * arrays could drift, and the drift would be invisible until an app reached a route nobody
 * intended. The Rust admission is built from this subset.
 */
export const APP_REACHABLE_SIDECAR_ROUTES: readonly SidecarRoute[] = SIDECAR_ROUTES.filter(
  (route) => !WIZARD_ONLY_PREFIXES.some((prefix) => route.path.startsWith(prefix)),
);

/** Turn a route pattern into an anchored matcher. Anchored both ends: no prefix extension. */
function routeMatcher(path: string): RegExp {
  const escaped = path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? PARAM_SEGMENT : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

const APP_ROUTE_MATCHERS: ReadonlyArray<{ method: SidecarMethod; matcher: RegExp }> =
  APP_REACHABLE_SIDECAR_ROUTES.map((route) => ({ method: route.method, matcher: routeMatcher(route.path) }));

/**
 * May an app issue `method` against `pathAndQuery`?
 *
 * THE TYPESCRIPT HALF of a guard whose enforcing half lives in Rust — stated here so the
 * app, the sidecar and the shell agree on one answer, and mirrored there because the TS
 * caller is not the last word on what the shell will dial (the `lan_fetch` precedent).
 *
 * Fails closed on everything it does not positively recognise: a malformed path, a
 * traversal attempt, an unknown route, a known path under the wrong verb. Query strings are
 * stripped before matching and can never widen a match — `/pair/status?x=1` is still a
 * pairing route.
 */
export function isAppReachableSidecarRoute(method: string, pathAndQuery: string): boolean {
  if (typeof method !== 'string' || typeof pathAndQuery !== 'string') return false;
  if (!pathAndQuery.startsWith('/')) return false;
  const path = pathAndQuery.split(/[?#]/, 1)[0] ?? '';

  // TRAVERSAL, REFUSED ON THE PRIMITIVE RATHER THAN ONE SPELLING (lessons.md 2026-08-11:
  // the attacker picks the spelling). Two facts make this necessary and non-obvious:
  //
  //   (1) `..` is a LEGAL single path segment, so `/chats/../messages` MATCHES the
  //       `/chats/:jid/messages` pattern exactly — the anchored matcher does not refuse
  //       it. This guard is the only thing that does. (A surviving mutant proved it: with
  //       this check deleted the suite stayed green, because every traversal fixture was
  //       also refused by the matcher and none exercised this line.)
  //   (2) A literal `..` scan is defeated by `%2e%2e`, and a literal `/` scan by `%2f`,
  //       for any consumer that decodes before resolving. So the path is DECODED first and
  //       the check runs on the decoded form — and a path whose encoding is malformed is
  //       refused rather than passed through, because a value we cannot decode is a value
  //       we cannot reason about.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false; // malformed percent-encoding — fail closed
  }
  if (decoded.split(/[/\\]/).some((segment) => segment === '..' || segment === '.')) return false;
  // A separator that survived encoding would let one segment span two after decoding.
  if (decoded !== path && /[/\\]/.test(decoded.slice(1))) {
    if (decoded.split('/').length !== path.split('/').length) return false;
  }

  return APP_ROUTE_MATCHERS.some((route) => route.method === method && route.matcher.test(path));
}

/**
 * The header carrying the sidecar access token. ONE spelling, referenced by the registry
 * entry's `headerTemplate`, written by the wizard and read by the sidecar.
 */
export const SIDECAR_AUTH_HEADER = 'authorization';

/**
 * The socket file's BASENAME. Deliberately not a path: the Rust side owns the directory
 * (`~/Snug`, as the user-file commands already do), so a webview cannot point the transport
 * at some other socket on the machine. A basename with no separator cannot express one.
 */
export const SIDECAR_SOCKET_BASENAME = 'whatsapp-sidecar.sock';

/**
 * The SYMBOLIC host a linked-device connection declares.
 *
 * Not routable and never dialled: `.localhost` is reserved by RFC 6761 precisely so it can
 * never be a real public host, and the helper listens on a unix socket with no TCP endpoint
 * at all. The name exists so the connection has a stable identity the frozen ceiling can
 * hold — hosts are the ceiling's unit, and a connection needs one.
 *
 * The EXECUTOR matches on this to route a request to the sidecar transport instead of the
 * network. Declared here rather than in the registry entry alone, because two surfaces now
 * depend on the same string and a second spelling would send the app's requests to a real
 * DNS lookup — which is exactly what happened before this constant existed: the app's reads
 * failed with NET_FETCH_FAILED while the wizard's identical connection worked.
 */
export const SIDECAR_SYMBOLIC_HOST = 'whatsapp.sidecar.localhost';

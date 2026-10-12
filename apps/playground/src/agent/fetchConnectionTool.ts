/**
 * fetchConnectionTool — the scheduled agent's ONE network tool: GET only, host-pinned, tainted
 * after a shared read (TASK-20261010-host-broker PR-4, D-PR4-13; ADR-0076 §9 amending ADR-0026;
 * security S1, S5, S6, S11, S14; feasibility F13).
 *
 * NO METHOD CAN BE EXPRESSED. The input is exactly `{connection, path, query?}`: a `method`, a
 * `body`, `headers` or a `url` the model adds are never read, and the executor is always asked for
 * a GET with no body — so the scheduled confirm gate (belt) is never even reached. GET-only is not
 * read-only, though: an API that acts on GET can be driven by what was fetched or shared. That is
 * bounded, not closed — the app's approved hosts, eight calls, the day's network ceiling, the
 * taint rule below, and `tools.fetched` on the result (D-PR4-23 names it).
 *
 * THE ADDRESS IS THE HOST'S. A row whose frozen ceiling is ONE host resolves symbolically
 * (`snug-connection://<slot><path>`, ADR-0026 — host-clean). Every OAuth ceiling is multi-host by
 * derivation, and the executor refuses a symbolic URL there, so a multi-host row composes
 * `https://<apiHost><path>` where `apiHost` is the ONE host the APPROVED requirement declares (never
 * a staged `pendingRequirement`'s) and it is in the frozen ceiling. ADR-0026's host guard runs only
 * on the executor's symbolic branch, so this tool asserts the composed URL's host itself, BEFORE the
 * executor: the WHATWG parser strips tab, LF and CR before resolving, and `/\t/evil.example/a` would
 * otherwise land on another host. The path grammar refuses that shape first; the assertion is the
 * belt. A failure on the composed path is answered by CODE only — a fixed sentence naming the slot —
 * because the executor's literal path labels its refusals with the raw host.
 *
 * REFUSED BY NAME BEFORE THE EXECUTOR: an app that may not reach the network, an unknown or
 * unapproved row, a sidecar-class slot (and the deps carry no `sidecarFetch` at all — a missing
 * transport, not only a check), a LAN-class row (and no `lanFetch` or private-http policy either —
 * LAN is out of `fetchableConnections` at PR-4), a row with no one address. Then the day's network
 * ceiling (`onNetCall`, counted BEFORE the executor, as the frame handler counts).
 *
 * THE TAINT. Once the turn has read another app's data (`taint()` — the agent's shared-read seat
 * recorded a grant), every call answers the taint sentence for the rest of the turn: shared rows
 * never ride a query string to the app's own hosts. Fetch-then-read stays allowed.
 *
 * WHAT RE-ENTERS THE CONTEXT. Every string returned — the status line's content type, the body,
 * each `Error: <code> — <message>` — passes the scheduler's `deliver` scrub BEFORE the cut: R-54's
 * exact-substring scrub inside the executor cannot see an injected value the service echoed
 * transformed (JSON-escaped), and the shape scrub can. A text that still looks like a credential
 * after it is withheld whole. The body is framed by `renderProviderResult` at 16,000 characters.
 */

import type { AgentTool } from '@snugprotocol/adapters';
import { createConnectedFetch, isHostAllowed, type ConnectedFetchResult } from '@snugprotocol/auth';
import type { ConnectionRow, UserDb } from '@snugprotocol/db';
import { getToolPrompt } from '@snugprotocol/knowledge';
import {
  CONNECTION_SLOT_RULE,
  CONNECTION_STATUS,
  FETCH_CONNECTION_MAX_CHARS,
  NET_ERROR_CODES,
  SIDECAR_SYMBOLIC_HOST,
  isRfc1918Ipv4Literal,
  normalizeAuthHost,
  type NetErrorCode,
} from '@snugprotocol/protocol';

import { appMayReachNetwork } from '../run/appCapabilityRules.js';
import { createScheduledConfirmGate } from '../schedule/scheduledConfirmGate.js';
import { scrubOrWithhold } from '../schedule/scrub.js';
import { NET_CALL_LIMIT_MESSAGE, authShapedFailureStore, connectedFetchDepsFor } from '../state/net.js';
import { renderProviderResult } from './providerTools.js';
import { oneLine } from './sharedDdl.js';

export const FETCH_CONNECTION_TOOL_NAME = 'fetch_connection';

/** A scheduled run's request bound — the executor's own default is the attended one. */
const REQUEST_TIMEOUT_MS = 30_000;

/** `path`: one leading `/`, then visible ASCII only — no whitespace, no C0, nothing the parser strips. */
const PATH_RULE = /^\/(?!\/)[!-~]*$/;
/** …and none of the three characters that end a path or turn into a separator. */
const PATH_FORBIDDEN = /[?#\\]/;
const PATH_MAX_CHARS = 2_048;

const TAINTED = 'Error: not after reading another app’s data in this run — answer with what you have';
const WITHHELD = 'Error: withheld — the answer looked like it carried a credential';
const CANCELLED = 'Error: cancelled — this run was stopped';
const NO_NETWORK = 'Error: this app may not reach the network here — answer from its data';
const BAD_PATH = `Error: "path" must start with one / and hold visible characters only — no spaces, no ?, # or \\ (put parameters in "query"), at most ${PATH_MAX_CHARS} characters`;
const BAD_QUERY = 'Error: "query" must be an object of text, number or true/false values';

export interface BuildFetchConnectionToolOptions {
  appId: string;
  getDb: () => Promise<UserDb>;
  /** Whether this turn has read another app's data — asked at EVERY call (the taint is turn-scoped). */
  taint: () => boolean;
  /**
   * The day's network ceiling, asked once per fetch BEFORE the executor with the connection's slot:
   * `true` admits it (and the caller counts it), `false` answers the limit sentence and sends nothing.
   */
  onNetCall?: (connection: string) => boolean;
  /** The turn's signal — an aborted turn sends nothing. */
  signal?: AbortSignal;
  /** Injectable transport for tests; defaults to the platform's fetch seam. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** A connection the agent may fetch through, as the consent and the agent name it. */
export interface FetchableConnection {
  /** The row's slot — what the tool's `connection` takes. */
  slot: string;
  /** The provider's display name, one line — what the user knows it as. */
  name: string;
}

// ---------------------------------------------------------------------------------------------
// Which rows, and where they lead
// ---------------------------------------------------------------------------------------------

const isSidecarRow = (row: ConnectionRow): boolean => (row.allowedHosts ?? []).includes(SIDECAR_SYMBOLIC_HOST);

/** The provider lane's `lan` fact: a collected-address seat, or a private literal in the ceiling. */
const isLanRow = (row: ConnectionRow): boolean => row.requirement.lanHost !== undefined || (row.allowedHosts ?? []).some(isRfc1918Ipv4Literal);

type Address = { kind: 'symbolic' } | { kind: 'composed'; apiHost: string } | { kind: 'none'; why: 'many' | 'unapproved' };

/** Where a row's requests go: its one host, or the one API host its APPROVED requirement declares (D-PR4-13). */
function addressOf(row: ConnectionRow): Address {
  const ceiling = row.allowedHosts ?? [];
  if (ceiling.length === 1) return { kind: 'symbolic' };
  const declared = new Set([...(row.requirement.declaredApiHosts ?? []), ...(row.requirement.userLayer?.declaredApiHosts ?? [])].map(normalizeAuthHost));
  const [apiHost] = declared;
  if (declared.size !== 1 || apiHost === undefined) return { kind: 'none', why: 'many' };
  return isHostAllowed(apiHost, ceiling) ? { kind: 'composed', apiHost } : { kind: 'none', why: 'unapproved' };
}

/**
 * The connections `fetch_connection` can reach for `appId` — approved, not the sidecar's, not a
 * LAN device's, with one address — in the file's order. None for an app that may not reach the
 * network. What the consent names and the agent's context lists (D-PR4-20).
 */
export function fetchableConnections(db: UserDb, appId: string): FetchableConnection[] {
  if (!appMayReachNetwork(appId)) return [];
  return db
    .listConnections(appId)
    .filter((row) => row.status === CONNECTION_STATUS.approved && !isSidecarRow(row) && !isLanRow(row) && addressOf(row).kind !== 'none')
    .map((row) => ({ slot: row.slot, name: oneLine(row.requirement.provider.name) }));
}

// ---------------------------------------------------------------------------------------------
// What the model reads back
// ---------------------------------------------------------------------------------------------

/** A composed-path failure, by CODE only: host-free, naming the slot (D-PR4-13). */
const COMPOSED_FAILURE: Readonly<Record<NetErrorCode, (slot: string) => string>> = {
  NET_INVALID_REQUEST: (slot) => `the request to ${slot} was not valid`,
  NET_NOT_APPROVED: (slot) => `${slot} is not approved for this app — the user connects it from the app’s Settings`,
  NET_IMPORTED_UNAPPROVED: (slot) => `${slot} arrived with an imported file and is not approved yet — the user confirms it in the app’s Settings`,
  NET_AMBIGUOUS_CONNECTION: () => 'two connections reach that service, so neither is used — the user removes one in the app’s Settings',
  NET_SCHEME_BLOCKED: (slot) => `${slot} is reachable over https only`,
  NET_HOST_BLOCKED: (slot) => `that address is not one ${slot} may reach`,
  NET_SSRF_BLOCKED: (slot) => `that address is not one ${slot} may reach`,
  NET_CONFIRM_DENIED: (slot) => `${slot} refused a request that would change something — this tool only reads`,
  NET_REDIRECT_BLOCKED: (slot) => `${slot} answered with a redirect, which is not followed`,
  NET_SIZE_EXCEEDED: (slot) => `${slot}’s answer was too large`,
  NET_FETCH_FAILED: (slot) => `the request to ${slot} could not be completed`,
  NET_AUTH_FAILED: (slot) => `${slot} refused the stored sign-in — the user reconnects it in the app’s Settings`,
  NET_SCRUBBED_HEADER_STRIPPED: (slot) => `${slot}’s answer was withheld`,
};

const isNetErrorCode = (code: string): code is NetErrorCode => Object.prototype.hasOwnProperty.call(NET_ERROR_CODES, code);

/** Every string this tool returns passes here: the `deliver` scrub, or the withheld sentence. */
const deliver = (text: string): string => scrubOrWithhold(text, 'deliver') ?? WITHHELD;

/** A success, scrubbed part by part BEFORE `renderProviderResult` cuts the body (D-PR4-13). */
function renderFetched(result: Extract<ConnectedFetchResult, { ok: true }>): string {
  const contentType = result.headers['content-type'];
  const safeType = contentType === undefined ? undefined : scrubOrWithhold(contentType, 'deliver');
  const safeBody = scrubOrWithhold(result.body, 'deliver');
  if (safeBody === undefined || (contentType !== undefined && safeType === undefined)) return WITHHELD;
  const headers: Record<string, string> = safeType === undefined ? {} : { 'content-type': safeType };
  const safe = { ...result, headers, body: safeBody };
  // The constant bounds the WHOLE answer, so the body gets what the frame leaves: the frame's own
  // length is measured on a two-character body cut at one (the cut's marker included).
  const frame = renderProviderResult({ ...safe, body: '..' }, { maxChars: 1 }).length - 1;
  return renderProviderResult(safe, { maxChars: Math.max(0, FETCH_CONNECTION_MAX_CHARS - frame) });
}

/** `query` as a search string — encoded by `URLSearchParams`, never pasted; `undefined` when it is not one. */
function searchOf(query: unknown): string | undefined {
  if (query === undefined) return '';
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return undefined;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) params.append(key, String(value));
    else return undefined;
  }
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------

export function buildFetchConnectionTool(options: BuildFetchConnectionToolOptions): AgentTool {
  const { appId, getDb, taint, onNetCall, signal, fetchImpl } = options;
  // One refusing gate for the turn (the scheduler's rule: a gate's record belongs to its run). A GET
  // never reaches a confirm gate; it is here so nothing mutating could ever be asked of a person.
  const confirmGate = createScheduledConfirmGate();
  // A function, not a narrowed read: `aborted` changes across the awaits below (the provider tool's rule).
  const isAborted = (): boolean => signal?.aborted === true;

  /** A refusal or failure as text (scrubbed whole by `run`), or a success already scrubbed part by part. */
  async function answer(input: Record<string, unknown>): Promise<string | { fetched: string }> {
    if (taint()) return TAINTED;
    if (isAborted()) return CANCELLED;
    if (!appMayReachNetwork(appId)) return NO_NETWORK;
    const db = await getDb();
    const known = (): string => fetchableConnections(db, appId).map((entry) => entry.slot).join(', ') || 'none';

    const slot = input.connection;
    if (typeof slot !== 'string' || !CONNECTION_SLOT_RULE.test(slot)) return `Error: "connection" must be one of this app’s connections: ${known()}`;
    const path = input.path;
    if (typeof path !== 'string' || path.length > PATH_MAX_CHARS || !PATH_RULE.test(path) || PATH_FORBIDDEN.test(path)) return BAD_PATH;
    const search = searchOf(input.query);
    if (search === undefined) return BAD_QUERY;

    const row = db.listConnections(appId).find((candidate) => candidate.slot === slot);
    if (row === undefined) return `Error: ${slot} is not one of this app’s connections — use one of: ${known()}`;
    if (row.status !== CONNECTION_STATUS.approved) return `Error: ${slot} is not approved for this app — the user connects it from the app’s Settings`;
    if (isSidecarRow(row)) return `Error: ${slot} talks to a helper on this device — it can’t be used from here`;
    if (isLanRow(row)) return `Error: ${slot} reaches a device on the local network — it can’t be used from here`;
    const address = addressOf(row);
    if (address.kind === 'none') {
      return address.why === 'many'
        ? `Error: ${slot} reaches more than one service, so there is no one address to fetch from`
        : `Error: ${slot} has no approved address to fetch from`;
    }

    let url: string;
    if (address.kind === 'symbolic') {
      url = `snug-connection://${slot}${path}${search}`;
    } else {
      // ADR-0026's guard, run here because the executor runs it only on the symbolic branch (S1).
      const composed = new URL(`${path}${search}`, `https://${address.apiHost}`);
      if (composed.protocol !== 'https:' || !isHostAllowed(composed.hostname, [address.apiHost])) return `Error: that path leaves ${slot}’s service — use a path on it`;
      url = composed.toString();
    }

    if (onNetCall?.(slot) === false) return `Error: ${NET_CALL_LIMIT_MESSAGE}`;

    const { sidecarFetch: _noSidecar, lanFetch: _noLan, transportPolicy: _noPrivateHttp, ...deps } = connectedFetchDepsFor(
      db,
      fetchImpl,
      (failedSlot, status, detail) =>
        authShapedFailureStore.set({ appId, slot: failedSlot, status, ...(detail !== undefined ? { detail } : {}), via: 'scheduled-run' }),
      confirmGate,
    );
    let result: ConnectedFetchResult;
    try {
      result = await createConnectedFetch({ ...deps, requestTimeoutMs: REQUEST_TIMEOUT_MS }).execute(appId, { url, method: 'GET' });
    } catch (err) {
      return address.kind === 'composed' ? `Error: ${COMPOSED_FAILURE.NET_FETCH_FAILED(slot)}` : `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Read again, not narrowed: the turn may have been stopped while the request was out.
    if (isAborted()) return CANCELLED;
    if (!result.ok) {
      if (address.kind === 'symbolic') return `Error: ${result.code} — ${result.message}`;
      const sentence = isNetErrorCode(result.code) ? COMPOSED_FAILURE[result.code](slot) : `the request to ${slot} did not succeed`;
      return `Error: ${result.code} — ${sentence}`;
    }
    return { fetched: renderFetched(result) };
  }

  return {
    def: {
      name: FETCH_CONNECTION_TOOL_NAME,
      description: getToolPrompt('fetch-connection'),
      inputSchema: {
        type: 'object',
        properties: {
          connection: { type: 'string' },
          path: { type: 'string' },
          query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        },
        required: ['connection', 'path'],
      },
    },
    run: async (input) => {
      const out = await answer(input);
      return typeof out === 'string' ? deliver(out) : out.fetched;
    },
  };
}

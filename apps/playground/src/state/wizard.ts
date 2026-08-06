// wizard.ts — the singleton auth-wizard store (AL-04 plan D5/D6/D9).
//
// One wizard open at a time; BOTH mounts (chat directive card, ConnectionsCard
// buttons, error CTA) call the same `openWizard`, and a second open while one is
// parked is refused with a visible note (R2, mutation M28).
//
// TRUST STORY (B2/AC13): a builder directive is a DOORBELL, never an authority.
// `resolveWizardIntent` re-runs the D4 provider ladder HOST-side at open:
// `lookupWellKnownProvider` first — on a hit the directive's endpoints/hints are
// DISCARDED in favor of registry values; on a miss the hints are LLM-authored,
// provenance is HOST-computed ('inference'), and review is the forced spec_confirm
// branch (AC3). Directive-carried provenance/confidence are display-only
// (`directiveDisplay`) and are never read by gating code (mutation M16).
//
// LIFECYCLE (M9): the wizard is minutes-lived, so OAuth flow state (the held
// `OAuthStartResult`) and the BroadcastChannel listener are STORE-owned — a view
// unmount or navigation cannot kill an in-flight exchange (mutation M23), and
// closing while a flow is in flight demands an explicit confirm.
//
// ORDER (B1/AC12): every OAuthService call here builds its SpecScope through
// `requireApprovedSpecScope` — credentials and token endpoints are structurally
// unreachable until the row is `approved` (mutations M13/M14).

import {
  AUTH_SPEC_STATUS,
  NET_ERROR_CODES,
  type AuthProvenance,
  type AuthWizardDirective,
  type LlmProposal,
} from '@snugprotocol/protocol';
import {
  InMemoryFlowStateStore,
  OAuthService,
  SnugAuthError,
  UserDbCredentialStore,
  lookupWellKnownProvider,
  requireApprovedSpecScope,
  type InferAuthSpecResult,
  type NetSpecReader,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthStartInput,
  type OAuthStartResult,
} from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import { createStore } from './store.js';
import { getUserDb } from './userdb.js';
import { invalidateNetGrants } from './net.js';

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

export type WizardMode = 'connect' | 'reapprove';

export type WizardSource = 'settings' | 'error_cta' | 'directive';

export interface WizardSession {
  appId: string;
  source: WizardSource;
  mode: WizardMode;
  /**
   * HOST-computed provenance (B2). Absent for row-review sessions (settings/error
   * CTA over an existing `snug_auth_specs` row — no LLM authored anything).
   * 'inference' | 'user_docs' force the field-by-field spec_confirm branch (AC3).
   */
  provenance?: AuthProvenance;
  /** The reviewable proposal for proposal-driven sessions (directive / inference). */
  proposal?: LlmProposal;
  /** Docs quotes from the inferrer — WIZARD-EPHEMERAL, never persisted (M1). */
  evidence: string[];
  /** Host-held confidence from a real inference run. UX copy grading ONLY (AC3). */
  confidence?: number;
  /** Transformer refusal reason or typed inferrer error to display (D3c/M11). */
  reason?: string;
  /** Display-only echoes of what the DIRECTIVE claimed (never read by gates, M16). */
  directiveDisplay?: { confidence?: number; provenance?: AuthProvenance };
}

export type WizardStep = 'review' | 'credentials' | 'done';

export type WizardFlowStatus =
  | { state: 'idle' }
  | { state: 'awaiting_callback'; flowId: string }
  | { state: 'exchanging' }
  | { state: 'connected'; scopesGranted?: string[] }
  | { state: 'error'; message: string };

export const wizardStore = createStore<WizardSession | null>(null);
export const wizardStepStore = createStore<WizardStep>('review');
export const wizardNoteStore = createStore<string | null>(null);
export const wizardFlowStatusStore = createStore<WizardFlowStatus>({ state: 'idle' });
/** True while the wizard is asking "a sign-in is in progress — close anyway?" (M9). */
export const wizardCloseConfirmStore = createStore<boolean>(false);

// ---------------------------------------------------------------------------
// Injectable seams (tests; production defaults below)
// ---------------------------------------------------------------------------

export interface WizardChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface WizardPopupLike {
  closed: boolean;
  close?: () => void;
  /**
   * Point an already-open popup at a URL. Present when the popup was opened
   * SYNCHRONOUSLY from the user's click (popup-blocker escape, D6): the window is
   * created on `about:blank` inside the gesture, then navigated here once the async
   * `generateAuthUrl` resolves. Absent for the legacy open-with-url path.
   */
  navigate?: (url: string) => void;
}

/** The OAuthService surface the wizard drives (injectable fake in tests). */
export interface WizardOAuthServiceLike {
  generateAuthUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  handleCallback(input: OAuthCallbackInput): Promise<OAuthCallbackResult>;
  saveClientCreds?(input: { appId: string; spec: OAuthStartInput['spec']; allowedHosts: readonly string[]; clientCreds: Record<string, string> }): Promise<void>;
}

export interface WizardInferenceInput {
  providerName: string;
  kindHint?: string;
  docsText?: string;
  signal?: AbortSignal;
}

interface WizardHooks {
  channelFactory?: (name: string) => WizardChannelLike;
  openPopup?: (url: string) => WizardPopupLike | null;
  /**
   * Open a BLANK popup synchronously (no URL yet) — the click-gesture handle the
   * popup-blocker fix opens before any await, later navigated via `navigate` (D6).
   */
  openBlankPopup?: () => WizardPopupLike | null;
  service?: WizardOAuthServiceLike;
  /** Injectable fetch for the REAL OAuthService (tests drive the full exchange offline). */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injectable inference runner (tests); default is the D2 adapter-layer wiring. */
  runInference?: (input: WizardInferenceInput) => Promise<InferAuthSpecResult>;
}

let hooks: WizardHooks = {};

export function __setWizardHooksForTests(next: WizardHooks): void {
  hooks = next;
}

// ---------------------------------------------------------------------------
// Store-owned flow state (M9)
// ---------------------------------------------------------------------------

interface ActiveFlow {
  start: OAuthStartResult;
  channel: WizardChannelLike;
  popup: WizardPopupLike | null;
  poll: ReturnType<typeof setInterval> | null;
}

let activeFlow: ActiveFlow | null = null;

/** The safe-default flow store, STORE-owned so a view unmount cannot drop it (M9). */
let flowStateStore = new InMemoryFlowStateStore();
let serviceSingleton: OAuthService | null = null;

function specReaderFor(db: UserDb): NetSpecReader {
  return {
    getAuthSpec: (appId) => {
      const row = db.getAuthSpec(appId);
      return row === undefined ? undefined : { spec: row.spec, status: row.status, allowedHosts: row.allowedHosts };
    },
  };
}

function wizardService(db: UserDb): WizardOAuthServiceLike {
  if (hooks.service !== undefined) return hooks.service;
  serviceSingleton ??= new OAuthService({
    store: new UserDbCredentialStore(db),
    redirectUriProvider: {
      // One seam, both call sites (D6): the hosted-origin callback route. The URI
      // shape is a launch-visible contract for BYO provider registration.
      redirectUri: () => `${window.location.origin}/oauth/callback`,
    },
    flowStore: flowStateStore,
    ...(hooks.fetchImpl !== undefined ? { fetch: hooks.fetchImpl } : {}),
  });
  return serviceSingleton;
}

function teardownFlow(): void {
  if (activeFlow === null) return;
  if (activeFlow.poll !== null) clearInterval(activeFlow.poll);
  activeFlow.channel.close();
  try {
    activeFlow.popup?.close?.();
  } catch {
    /* popup already gone */
  }
  activeFlow = null;
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export type WizardOpenRequest =
  | { source: 'settings' | 'error_cta'; appId: string; mode: WizardMode }
  | { source: 'directive'; appId: string; directive: AuthWizardDirective };

/**
 * The B2 ladder re-run at the directive mount (AC13). Registry hit ⇒ the directive's
 * endpoints/hints are DISCARDED — only the provider identity survives, and the kind
 * is the registry rung's (`oauth2_auth_code`, matching the inferrer's registry rung).
 * Registry miss ⇒ the hints are LLM-authored: provenance 'inference', forced
 * spec_confirm. The directive's provenance/confidence claims land in
 * `directiveDisplay` and nowhere else.
 */
export function resolveWizardIntent(appId: string, directive: AuthWizardDirective): WizardSession {
  const directiveDisplay =
    directive.confidence !== undefined || directive.provenance !== undefined
      ? {
          ...(directive.confidence !== undefined ? { confidence: directive.confidence } : {}),
          ...(directive.provenance !== undefined ? { provenance: directive.provenance } : {}),
        }
      : undefined;
  const base = { appId, source: 'directive' as const, mode: 'connect' as const, evidence: [] };
  const wellKnown = lookupWellKnownProvider(directive.proposal.providerName);
  if (wellKnown !== undefined) {
    return {
      ...base,
      provenance: 'registry',
      proposal: { providerName: directive.proposal.providerName, kindHint: 'oauth2_auth_code' },
      ...(directiveDisplay !== undefined ? { directiveDisplay } : {}),
    };
  }
  return {
    ...base,
    provenance: 'inference',
    proposal: directive.proposal,
    ...(directiveDisplay !== undefined ? { directiveDisplay } : {}),
  };
}

/** Open the wizard (both mounts). Returns false — with a visible note — when one is parked (R2/M28). */
export function openWizard(request: WizardOpenRequest): boolean {
  if (wizardStore.get() !== null) {
    wizardNoteStore.set('a connection wizard is already open — finish or dismiss it first');
    return false;
  }
  wizardNoteStore.set(null);
  wizardCloseConfirmStore.set(false);
  wizardStepStore.set('review');
  wizardFlowStatusStore.set({ state: 'idle' });
  const session: WizardSession =
    request.source === 'directive'
      ? resolveWizardIntent(request.appId, request.directive)
      : { appId: request.appId, source: request.source, mode: request.mode, evidence: [] };
  wizardStore.set(session);
  return true;
}

export type WizardCloseVerdict = 'closed' | 'needs_confirm';

/**
 * Sheet.tsx closes on Esc AND backdrop tap; one stray tap must not discard an
 * in-flight OAuth exchange (M9). With a flow in flight this returns 'needs_confirm'
 * and the wizard renders an explicit confirm; `forceCloseWizard` is the "close
 * anyway".
 */
export function requestCloseWizard(): WizardCloseVerdict {
  if (activeFlow !== null) {
    wizardCloseConfirmStore.set(true);
    return 'needs_confirm';
  }
  forceCloseWizard();
  return 'closed';
}

export function forceCloseWizard(): void {
  teardownFlow();
  wizardStore.set(null);
  wizardStepStore.set('review');
  wizardCloseConfirmStore.set(false);
  wizardFlowStatusStore.set({ state: 'idle' });
}

// ---------------------------------------------------------------------------
// Approval (B1: review → put → approve → ONLY THEN credentials)
// ---------------------------------------------------------------------------

export type WizardApproveResult = { ok: true } | { ok: false; message: string };

/**
 * Approve the reviewed spec and advance to the credentials step. For
 * proposal-driven sessions the caller passes the (possibly user-edited) hints and
 * the deterministic transformer stays the ONLY spec builder; edits that would change
 * a frozen union route through `reapproveAuthSpec` (the HostFreezeViolation split is
 * designed around, never a surprise). EVERY approval transition invalidates the
 * app's remembered net grants (AC9/R3 — AL-03's M23 guard stays red-capable).
 */
export async function approveWizardSpec(spec?: unknown): Promise<WizardApproveResult> {
  const session = wizardStore.get();
  if (session === null) return { ok: false, message: 'no wizard session' };
  const db = await getUserDb();
  try {
    const existing = db.getAuthSpec(session.appId);
    if (spec !== undefined) {
      if (existing?.status === AUTH_SPEC_STATUS.approved || session.mode === 'reapprove') {
        db.reapproveAuthSpec(session.appId, spec);
      } else {
        db.putAuthSpec(session.appId, spec);
        db.approveAuthSpec(session.appId);
      }
    } else if (session.mode === 'reapprove') {
      db.reapproveAuthSpec(session.appId);
    } else {
      db.approveAuthSpec(session.appId);
    }
    invalidateNetGrants(session.appId); // R3 — every approval transition
    wizardStepStore.set('credentials');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// OAuth popup flow (D6; store-owned, M9; post-approval only, B1)
// ---------------------------------------------------------------------------

const POPUP_POLL_MS = 500;

function defaultChannelFactory(name: string): WizardChannelLike {
  const channel = new BroadcastChannel(name);
  const like: WizardChannelLike = {
    onmessage: null,
    close: () => channel.close(),
  };
  channel.onmessage = (event) => like.onmessage?.({ data: event.data });
  return like;
}

function defaultOpenPopup(url: string): WizardPopupLike | null {
  return window.open(url, 'snug-oauth', 'popup,width=480,height=720');
}

/**
 * Open the popup SYNCHRONOUSLY on the user's click — `about:blank`, no URL yet — so
 * the window rides the gesture and a default popup blocker lets it through. It is
 * navigated to the authorize URL later (D6, `navigate`), once `generateAuthUrl`
 * resolves. This is the popup-blocker fix: `startOAuthFlow` awaits `getUserDb` +
 * `requireApprovedSpecScope` + `generateAuthUrl` before the URL exists, and a
 * `window.open` after those awaits is no longer gesture-associated → blocked.
 */
export function openBlankOAuthPopup(): WizardPopupLike | null {
  const win = window.open('about:blank', 'snug-oauth', 'popup,width=480,height=720');
  if (win === null) return null;
  return {
    get closed() {
      return win.closed;
    },
    close: () => win.close(),
    navigate: (url: string) => {
      win.location.href = url;
    },
  };
}

/**
 * Start the 3-legged flow for the CURRENT session. Precondition (B1): the spec row
 * is `approved` — the SpecScope comes from `requireApprovedSpecScope` and this
 * throws (flow never starts, no popup, no wire) otherwise.
 *
 * `preOpened` is the blank popup the CLICK HANDLER opened synchronously (popup-blocker
 * escape): when present it is navigated to the authorize URL here; when absent (the
 * legacy/test-direct path) the popup is opened with the URL the old way. If the flow
 * aborts before it starts (e.g. the B1 approval gate throws), the pre-opened popup is
 * closed so a blank window is never orphaned.
 */
export async function startOAuthFlow(
  clientCreds: Record<string, string>,
  preOpened?: WizardPopupLike | null,
): Promise<void> {
  const session = wizardStore.get();
  if (session === null) {
    preOpened?.close?.();
    throw new Error('no wizard session');
  }
  let start: OAuthStartResult;
  let scope: Awaited<ReturnType<typeof requireApprovedSpecScope>>;
  let service: WizardOAuthServiceLike;
  try {
    const db = await getUserDb();
    scope = await requireApprovedSpecScope(specReaderFor(db), session.appId); // B1 wall
    service = wizardService(db);
    start = await service.generateAuthUrl({ appId: scope.appId, spec: scope.spec, clientCreds });
  } catch (err) {
    // The approval gate (B1) or the URL mint failed — never orphan the blank window.
    preOpened?.close?.();
    throw err;
  }

  // The initiating context knows the channel name because it HOLDS the flowId —
  // the payload can never teach it (D6).
  const channel = (hooks.channelFactory ?? defaultChannelFactory)(`snug-oauth-${start.flowId}`);
  channel.onmessage = (event) => {
    void handleDelivery(event.data);
  };

  // Navigate the gesture-opened popup if we have one (the fix path); otherwise open
  // one with the URL directly (legacy path — direct callers/tests that pass no popup).
  let popup: WizardPopupLike | null;
  if (preOpened != null && preOpened.navigate !== undefined) {
    preOpened.navigate(start.authorizeUrl);
    popup = preOpened;
  } else {
    preOpened?.close?.(); // a pre-opened popup that can't navigate is unusable — don't leak it
    popup = (hooks.openPopup ?? defaultOpenPopup)(start.authorizeUrl);
  }
  // Popup-closed polling backstop: BroadcastChannel delivery has no failure signal.
  const poll =
    popup !== null
      ? setInterval(() => {
          if (popup.closed && wizardFlowStatusStore.get().state === 'awaiting_callback') {
            wizardFlowStatusStore.set({ state: 'error', message: 'the sign-in window closed — try again' });
            teardownFlow();
          }
        }, POPUP_POLL_MS)
      : null;

  activeFlow = { start, channel, popup, poll };
  wizardFlowStatusStore.set({ state: 'awaiting_callback', flowId: start.flowId });
}

/** Parse-don't-trust over the delivered payload; the flow BINDING is the held copy (AC6). */
async function handleDelivery(data: unknown): Promise<void> {
  const flow = activeFlow;
  const session = wizardStore.get();
  if (flow === null || session === null) return;
  if (typeof data !== 'object' || data === null) return;
  const delivery = data as Record<string, unknown>;
  const code = delivery['code'];
  const state = delivery['state'];
  if (typeof code !== 'string' || typeof state !== 'string' || code.length === 0 || state.length === 0) return;

  wizardFlowStatusStore.set({ state: 'exchanging' });
  try {
    const db = await getUserDb();
    const scope = await requireApprovedSpecScope(specReaderFor(db), session.appId); // B1, again at use
    const result = await wizardService(db).handleCallback({
      appId: scope.appId,
      spec: scope.spec,
      allowedHosts: scope.allowedHosts,
      code,
      state,
      // AC6: the caller's OWN held copy — never parsed out of the delivery.
      expectedFlowId: flow.start.flowId,
    });
    wizardFlowStatusStore.set({
      state: 'connected',
      ...(result.scopesGranted !== undefined ? { scopesGranted: result.scopesGranted } : {}),
    });
    wizardStepStore.set('done');
  } catch (err) {
    const message =
      err instanceof SnugAuthError ? `${err.message} (${err.code})` : err instanceof Error ? err.message : String(err);
    wizardFlowStatusStore.set({ state: 'error', message });
  } finally {
    teardownFlow();
  }
}

/**
 * Client-credentials save+mint (D5) — post-approval only (B1): the SpecScope is the
 * approved row's frozen scope, never a proposal-derived union.
 */
export async function saveWizardClientCreds(clientCreds: Record<string, string>): Promise<void> {
  const session = wizardStore.get();
  if (session === null) throw new Error('no wizard session');
  const db = await getUserDb();
  const scope = await requireApprovedSpecScope(specReaderFor(db), session.appId); // B1 wall
  const service = wizardService(db);
  if (service.saveClientCreds === undefined) {
    await (service as OAuthService).saveClientCreds({ ...scope, clientCreds });
  } else {
    await service.saveClientCreds({ ...scope, clientCreds });
  }
  wizardStepStore.set('done');
}

// ---------------------------------------------------------------------------
// Inference plumbing (D3/M11)
// ---------------------------------------------------------------------------

/**
 * Fold an inference result into the session. Success carries the reviewable
 * proposal + wizard-ephemeral evidence; a typed failure leaves the confirm EMPTY —
 * nothing prefilled (M11) — with only the message to display.
 */
export function applyInferenceResult(result: InferAuthSpecResult): void {
  const session = wizardStore.get();
  if (session === null) return;
  if (result.ok) {
    wizardStore.set({
      ...session,
      provenance: result.provenance,
      proposal: result.proposal,
      evidence: result.evidence,
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      ...(result.spec === null ? { reason: result.reason } : { reason: undefined }),
    });
  } else {
    wizardStore.set({
      ...session,
      provenance: result.provenance,
      proposal: undefined,
      evidence: [],
      confidence: undefined,
      reason: result.message,
    });
  }
}

export type WizardInferenceOutcome = { blocked: 'tripwire' } | { blocked?: undefined; result: InferAuthSpecResult };

/**
 * Run the inferrer for the current session. THE TRIPWIRE RUNS FIRST (D10/M2,
 * mutation M19): pasted docs that look like they contain a real credential block
 * the call until the user explicitly overrides — `docsText` transits to the BYOK
 * provider by design, and this is the last moment to catch an accidental secret.
 */
export async function runWizardInference(
  input: WizardInferenceInput & { override?: boolean },
): Promise<WizardInferenceOutcome> {
  if (input.docsText !== undefined && input.override !== true && docsTripwire(input.docsText)) {
    return { blocked: 'tripwire' };
  }
  const run =
    hooks.runInference ??
    (async (request: WizardInferenceInput): Promise<InferAuthSpecResult> => {
      const { runAuthSpecInference } = await import('../agent/inferrerAdapter.js');
      return runAuthSpecInference(request);
    });
  const result = await run({
    providerName: input.providerName,
    ...(input.kindHint !== undefined ? { kindHint: input.kindHint } : {}),
    ...(input.docsText !== undefined ? { docsText: input.docsText } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  applyInferenceResult(result);
  return { result };
}

// ---------------------------------------------------------------------------
// Paste-box credential tripwire (D10/M2, mutation M19)
// ---------------------------------------------------------------------------

const TRIPWIRE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/, // Anthropic/OpenAI-style keys
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/, // AWS access key ids
  /\bBearer\s+ey[A-Za-z0-9._~+/-]{10,}/i, // pasted JWT bearer
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub PATs
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[A-Za-z0-9_-]{10,}/, // Google
];

/** High-entropy token heuristic: a long base64ish run mixing cases and digits. */
function looksHighEntropy(text: string): boolean {
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const token = match[0];
    if (/^https?:/i.test(token)) continue;
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token)) return true;
  }
  return false;
}

/**
 * True when pasted docs look like they contain a REAL credential (R5): the wizard
 * warns and requires explicit override BEFORE the completion seam is invoked —
 * docsText transits to the user's BYOK provider by design (D10), and this is the
 * moment to catch an accidental secret.
 */
export function docsTripwire(text: string): boolean {
  return TRIPWIRE_PATTERNS.some((pattern) => pattern.test(text)) || looksHighEntropy(text);
}

// ---------------------------------------------------------------------------
// Error → CTA mapping (D7/N1; mutations M25/M26)
// ---------------------------------------------------------------------------

/**
 * Code-keyed, NEVER a message substring (N1). ALL `NET_AUTH_FAILED` causes are
 * auth-repairable as shipped (missing credential, template error, mint/refresh
 * failure), so the connect CTA is never misleading. Off-ceiling and confirm-denied
 * codes return null — routing them to a connect CTA would coach the user into
 * widening the ceiling in direct response to an attack (M12).
 */
export function netErrorCta(code: string): WizardMode | null {
  if (code === NET_ERROR_CODES.NET_AUTH_FAILED || code === NET_ERROR_CODES.NET_NOT_APPROVED) return 'connect';
  if (code === NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED) return 'reapprove';
  return null;
}

/** Open the wizard for a net error — consults ONLY the code via `netErrorCta`. */
export function openWizardForNetError(appId: string, code: string): boolean {
  const mode = netErrorCta(code);
  if (mode === null) return false;
  return openWizard({ source: 'error_cta', appId, mode });
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export function __resetWizardStateForTests(): void {
  teardownFlow();
  hooks = {};
  serviceSingleton = null;
  flowStateStore = new InMemoryFlowStateStore();
  wizardStore.set(null);
  wizardStepStore.set('review');
  wizardNoteStore.set(null);
  wizardFlowStatusStore.set({ state: 'idle' });
  wizardCloseConfirmStore.set(false);
}

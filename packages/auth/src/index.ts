// @snugprotocol/auth — the Dynamic Auth pure core (AL-02, TASK-20260805-auth-core)
// plus the connected-fetch runtime (AL-03, TASK-20260806-connected-fetch).
// Local-first custody per ADR-0014: every credential value lives in the user's own
// file (`snug_secrets` `auth:` keys via @snugprotocol/db); grant metadata lives in
// `snug_connections` (@snugprotocol/protocol schema, frozen-host union enforced in
// @snugprotocol/db — v3's `snug_auth_specs` was dropped at userdb v5). Hard constraint C1: host-bound injection is always strict —
// nothing in this package exposes a strictness knob, flag, or env read (browser-safe,
// WebCrypto only). Wizard/UI is AL-04.

export {
  base64ToBytes,
  base64UrlToBytes,
  base64UrlToUtf8,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  randomBase64Url,
  utf8ToBase64,
  utf8ToBase64Url,
} from './base64url.js';

export {
  createConnectedFetch,
  executeConnectionTestRequest,
  /**
   * The v4 OAuth plumbing, exported in the P3 fold because the wizard's reinstated connect
   * step is the SECOND consumer — and the whole point is that it is the same plumbing, not
   * a second copy.
   *
   * `SlotScopedCredentialStore` is what lets an unchanged, slot-unaware `OAuthService`
   * read and write a v4 grant's tokens under `auth:<appId>:<slot>:*`; a re-implementation
   * in the playground would be a second re-key that could drift from this one, and a
   * drifted re-key means one slot serving another slot's token. `requirementToSpec` is the
   * one dialect translation between the flat v4 requirement and the discriminated v3 spec
   * the service still speaks — two copies of it would eventually disagree about which
   * endpoints an OAuth requirement carries, and the disagreement would surface as a sign-in
   * that mints against one URL and refreshes against another.
   */
  SlotScopedCredentialStore,
  requirementToSpec,
  type ConnectedFetch,
  type ConnectedFetchDeps,
  type ConnectedFetchResult,
  type NetConfirmGate,
  // The v4 (`snug_connections`) reader pair. Exported in P3 because the playground's
  // net wiring is the consumer that finally routes through it — until a host could name
  // these types, the v3 spec reader was the only reachable path out of this package.
  type NetConnectionReader,
  type NetConnectionRow,
  type NetRequestInput,
} from './connected-fetch.js';

export { isForbiddenNetHost } from './net-guards.js';

export { scrubAuthValues } from './scrub.js';

export {
  createSessionConfirmGate,
  type NetConfirmDecision,
  type NetConfirmPrompt,
  type NetConfirmRequest,
  type SessionConfirmGate,
} from './session-confirm.js';

export {
  UserDbCredentialStore,
  type AuthConnectionState,
  type CredentialStore,
  type SecretsQuartet,
} from './credential-store.js';

export {
  TWO_LAYER_RESOLUTION_DEFERRED,
  resolveAuthMode,
  type AuthMode,
  type AuthModeCaller,
  type AuthModeResolution,
} from './auth-mode.js';

export {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  type WellKnownOauthProvider,
} from './well-known-providers.js';

export {
  AUTH_ENGINE_HELPER_NAMES,
  AuthTemplateError,
  renderAuthHeaderTemplate,
  type AuthTemplateContext,
  type AuthTemplateRequest,
} from './template-engine.js';

export {
  AUTH_TEMPLATE_HELPERS,
  AUTH_TEMPLATE_REQUEST_TOKENS,
  AuthTemplateLintError,
  assertLintedTemplate,
  lintAuthHeaderTemplate,
  type AuthTemplateHelper,
  type AuthTemplateLintIssue,
  type AuthTemplateLintOptions,
  type AuthTemplateLintResult,
  type AuthTemplateRequestToken,
} from './template-lint.js';

export {
  ADMISSION_CHANNELS,
  admitConnectionRequirement,
  type AdmissionChannel,
  type AdmissionIssue,
  type AdmissionOptions,
  type AdmissionResult,
} from './requirement-admission.js';

export { paramsToAuthSpec, type ParamsToAuthSpecInput, type ParamsToAuthSpecResult } from './params-to-auth-spec.js';

export {
  AUTH_INFERENCE_CONFIDENCE_NOTE_THRESHOLD,
  createAuthSpecInferrer,
  needsUnsureConfidenceNote,
  type AuthSpecInferrer,
  type AuthSpecInferrerDeps,
  type AuthSpecInferrerErrorCode,
  type InferAuthSpecInput,
  type InferAuthSpecResult,
  type InferrerComplete,
} from './auth-spec-inferrer.js';

/**
 * Dynamic Auth v2 (P2): the FULL-requirement inferrer. Additive — the v3 inferrer above
 * keeps shipping until P4 retires it (fold B1).
 */
export {
  createConnectionRequirementInferrer,
  type ConnectionRequirementInferrer,
  type ConnectionRequirementInferrerDeps,
  type ConnectionRequirementInferrerErrorCode,
  type InferConnectionRequirementInput,
  type InferConnectionRequirementResult,
  type RequirementInferrerComplete,
} from './connection-requirement-inferrer.js';


export { isHostAllowed, isUrlWithinHosts, undeclaredHosts } from './app-host-freeze.js';

export {
  InMemoryFlowStateStore,
  OAuthService,
  SecretSpillFlowStateStore,
  SnugAuthError,
  constantTimeEqual,
  generatePkceVerifier,
  pkceChallenge,
  signState,
  verifyState,
  type CallbackDelivery,
  type CallbackSink,
  type FetchLike,
  type FlowState,
  type FlowStateStore,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthServiceDeps,
  type OAuthStartInput,
  type OAuthStartResult,
  type RedirectUriProvider,
  type SignedStatePayload,
  type SnugAuthErrorCode,
  type SpecScope,
} from './oauth-service.js';

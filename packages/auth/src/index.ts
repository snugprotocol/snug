// @snugprotocol/auth — the Dynamic Auth pure core (AL-02, TASK-20260805-auth-core)
// plus the connected-fetch runtime (AL-03, TASK-20260806-connected-fetch).
// Local-first custody per ADR-0014: every credential value lives in the user's own
// file (`snug_secrets` `auth:` keys via @snugprotocol/db); spec metadata lives in
// `snug_auth_specs` (@snugprotocol/protocol schema, frozen-host union enforced in
// @snugprotocol/db). Hard constraint C1: host-bound injection is always strict —
// nothing in this package exposes a strictness knob, flag, or env read (browser-safe,
// WebCrypto only). Wizard/UI is AL-04.

export {
  base64UrlToBytes,
  base64UrlToUtf8,
  bytesToBase64Url,
  bytesToHex,
  randomBase64Url,
  utf8ToBase64,
  utf8ToBase64Url,
} from './base64url.js';

export {
  createConnectedFetch,
  type ConnectedFetch,
  type ConnectedFetchDeps,
  type ConnectedFetchResult,
  type NetConfirmGate,
  type NetRequestInput,
  type NetSpecReader,
  type NetSpecRow,
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
  AuthTemplateError,
  renderAuthHeaderTemplate,
  renderAuthTemplateString,
  type AuthTemplateContext,
  type AuthTemplateRequest,
} from './template-engine.js';

export { paramsToAuthSpec, type ParamsToAuthSpecInput, type ParamsToAuthSpecResult } from './params-to-auth-spec.js';

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
} from './oauth-service.js';

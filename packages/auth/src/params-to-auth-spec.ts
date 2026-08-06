/**
 * paramsToAuthSpec — the deterministic hints→spec transformer, REWRITTEN per plan D2
 * (AL-02): OProject's five-kind shapes + two-layer userLayer synthesis, reconciled
 * with IProject's fail-closed posture. No LLM call ever happens here; when inputs are
 * insufficient it returns `{ spec: null, reason }` so the caller (AL-04's wizard tool)
 * can ask for more, never guess.
 *
 * Host rules (plan D2 — the branch points at data that exists):
 *   - api_key / bearer_token / basic_auth / oauth2_client_creds:
 *     `declaredApiHosts` REQUIRED non-empty.
 *   - oauth2_auth_code: may be omitted ONLY when the well-known registry supplies a
 *     human-reviewed `apiHosts` list for the provider (it is copied into the spec);
 *     otherwise required.
 *
 * Per-provider consent params (plan D6): registry `authorizeParams` are copied into
 * the spec — the OAuth service applies what the SPEC carries, never a hardcoded
 * Google-ism.
 */

import {
  authSpecSchema,
  type AuthField,
  type AuthSpec,
  type AuthSpecHints,
  type Oauth2AuthCodeSpec,
} from '@snugprotocol/protocol';
import { lookupWellKnownProvider } from './well-known-providers.js';

/**
 * The transformer input, RE-DERIVED from the protocol's single-source-of-truth hints
 * schema (AL-04 plan D1/M8): `AuthSpecHints = z.infer<typeof authSpecHintsSchema>`.
 * TYPE-ONLY change — runtime behavior is unchanged and locked by this module's
 * existing test suite (risk R7). Hand-maintained drift between the directive/inferrer
 * boundary shape and this input is now a compile error, never a runtime surprise.
 */
export type ParamsToAuthSpecInput = AuthSpecHints;

export interface ParamsToAuthSpecResult {
  spec: AuthSpec | null;
  reason: string;
}

const KIND_LIST = 'api_key, bearer_token, basic_auth, oauth2_client_creds, oauth2_auth_code';

const DEFAULT_CLIENT_CRED_FIELDS: AuthField[] = [
  { key: 'client_id', label: 'Client ID', type: 'text' },
  { key: 'client_secret', label: 'Client Secret', type: 'secret' },
];

function fail(reason: string): ParamsToAuthSpecResult {
  return { spec: null, reason };
}

export function paramsToAuthSpec(input: ParamsToAuthSpecInput): ParamsToAuthSpecResult {
  if (input.kindHint === undefined || input.kindHint.length === 0) {
    return fail(`kindHint is required — pass one of ${KIND_LIST}.`);
  }
  if (input.providerName.trim().length === 0) {
    return fail('providerName is required.');
  }

  const wellKnown = lookupWellKnownProvider(input.providerName);

  const provider = {
    name: wellKnown?.displayName ?? input.providerName.trim(),
    ...(input.homepageUrl !== undefined ? { homepageUrl: input.homepageUrl } : {}),
    ...(input.docsUrl !== undefined ? { docsUrl: input.docsUrl } : {}),
  };

  const hasInstructions = input.registrationInstructions !== undefined && input.registrationInstructions.length > 0;
  const registration =
    input.registrationConsoleUrl !== undefined || hasInstructions
      ? {
          ...(input.registrationConsoleUrl !== undefined ? { consoleUrl: input.registrationConsoleUrl } : {}),
          ...(hasInstructions ? { instructions: input.registrationInstructions } : {}),
        }
      : undefined;

  const request =
    input.headerTemplate !== undefined && Object.keys(input.headerTemplate).length > 0
      ? { headerTemplate: input.headerTemplate }
      : undefined;

  const explicitHosts = (input.declaredApiHosts ?? []).filter((h) => h.length > 0);

  /** Static/CC kinds: declared hosts are required, full stop (fail-closed posture). */
  const requireDeclaredHosts = (): string[] | undefined => (explicitHosts.length > 0 ? explicitHosts : undefined);

  let candidate: unknown;

  switch (input.kindHint) {
    case 'bearer_token': {
      const hosts = requireDeclaredHosts();
      if (hosts === undefined) return fail('bearer_token requires a non-empty declaredApiHosts list (the credential is fail-closed).');
      candidate = {
        kind: 'bearer_token',
        provider,
        ...(registration !== undefined ? { registration } : {}),
        fields:
          input.fields !== undefined && input.fields.length > 0
            ? input.fields
            : [{ key: 'token', label: 'Bearer Token', type: 'secret' }],
        ...(request !== undefined ? { request } : {}),
        declaredApiHosts: hosts,
      };
      break;
    }
    case 'basic_auth': {
      const hosts = requireDeclaredHosts();
      if (hosts === undefined) return fail('basic_auth requires a non-empty declaredApiHosts list (the credential is fail-closed).');
      candidate = {
        kind: 'basic_auth',
        provider,
        ...(registration !== undefined ? { registration } : {}),
        fields:
          input.fields !== undefined && input.fields.length === 2
            ? input.fields
            : [
                { key: 'username', label: 'Username', type: 'text' },
                { key: 'password', label: 'Password', type: 'password' },
              ],
        ...(request !== undefined ? { request } : {}),
        declaredApiHosts: hosts,
      };
      break;
    }
    case 'api_key': {
      const hosts = requireDeclaredHosts();
      if (hosts === undefined) return fail('api_key requires a non-empty declaredApiHosts list (the credential is fail-closed).');
      candidate = {
        kind: 'api_key',
        provider,
        ...(registration !== undefined ? { registration } : {}),
        fields:
          input.fields !== undefined && input.fields.length > 0
            ? input.fields
            : [{ key: 'api_key', label: 'API Key', type: 'secret' }],
        ...(request !== undefined ? { request } : {}),
        declaredApiHosts: hosts,
      };
      break;
    }
    case 'oauth2_client_creds': {
      const hosts = requireDeclaredHosts();
      if (hosts === undefined) return fail('oauth2_client_creds requires a non-empty declaredApiHosts list (the credential is fail-closed).');
      if (input.endpoints?.tokenUrl === undefined) {
        return fail('oauth2_client_creds requires endpoints.tokenUrl. Pass it or pick a different kindHint.');
      }
      candidate = {
        kind: 'oauth2_client_creds',
        provider,
        ...(registration !== undefined ? { registration } : {}),
        endpoints: { tokenUrl: input.endpoints.tokenUrl },
        ...(input.scopes !== undefined && input.scopes.length > 0 ? { scopes: input.scopes } : {}),
        clientCreds: input.fields !== undefined && input.fields.length > 0 ? input.fields : DEFAULT_CLIENT_CRED_FIELDS,
        declaredApiHosts: hosts,
      };
      break;
    }
    case 'oauth2_auth_code': {
      const authorizeUrl = input.endpoints?.authorizeUrl ?? wellKnown?.endpoints.authorizeUrl;
      const tokenUrl = input.endpoints?.tokenUrl ?? wellKnown?.endpoints.tokenUrl;
      const refreshUrl = input.endpoints?.refreshUrl ?? wellKnown?.endpoints.refreshUrl;
      const revokeUrl = input.endpoints?.revokeUrl ?? wellKnown?.endpoints.revokeUrl;
      if (authorizeUrl === undefined || tokenUrl === undefined) {
        return fail(
          `oauth2_auth_code requires endpoints.authorizeUrl + endpoints.tokenUrl, and provider "${input.providerName}" is not in the well-known registry. Pass them explicitly.`,
        );
      }
      // D2: empty declaredApiHosts is allowed ONLY when the registry supplies apiHosts.
      const hosts = explicitHosts.length > 0 ? explicitHosts : wellKnown?.apiHosts;
      if (hosts === undefined || hosts.length === 0) {
        return fail(
          `oauth2_auth_code for unknown provider "${input.providerName}" requires a non-empty declaredApiHosts list (no registry apiHosts to fall back on).`,
        );
      }
      const pkce = input.pkce ?? wellKnown?.pkce ?? true;
      const authorizeParams = wellKnown?.authorizeParams;
      candidate = {
        kind: 'oauth2_auth_code',
        provider,
        ...(registration !== undefined ? { registration } : {}),
        endpoints: {
          authorizeUrl,
          tokenUrl,
          ...(refreshUrl !== undefined ? { refreshUrl } : {}),
          ...(revokeUrl !== undefined ? { revokeUrl } : {}),
        },
        ...(input.scopes !== undefined && input.scopes.length > 0 ? { scopes: input.scopes } : {}),
        pkce,
        ...(authorizeParams !== undefined ? { authorizeParams } : {}),
        clientCreds: input.fields !== undefined && input.fields.length > 0 ? input.fields : DEFAULT_CLIENT_CRED_FIELDS,
        declaredApiHosts: hosts,
      };
      break;
    }
    default:
      return fail(`Unknown kindHint "${input.kindHint}". Use one of: ${KIND_LIST}.`);
  }

  // Two-layer synthesis (@draft): embed a userLayer oauth2_auth_code spec inside the
  // org-eligible candidate. oauth2_auth_code can never BE the org layer.
  if (input.authMode === 'two_layer') {
    if (input.kindHint === 'oauth2_auth_code') {
      return fail(
        'authMode="two_layer" requires an org-eligible kindHint (api_key, bearer_token, basic_auth, or oauth2_client_creds) — the 3-legged flow is the USER layer, not the org layer.',
      );
    }
    const userLayerResult = buildUserLayerSpec(input);
    if (userLayerResult.spec === null) return fail(userLayerResult.reason);
    candidate = { ...(candidate as Record<string, unknown>), userLayer: userLayerResult.spec };
  }

  const validated = authSpecSchema.safeParse(candidate);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return fail(`Built spec failed schema validation: ${issues}`);
  }

  return {
    spec: validated.data,
    reason:
      input.authMode === 'two_layer'
        ? `Built ${validated.data.kind} spec with embedded userLayer (two_layer) from supplied hints.`
        : `Built ${validated.data.kind} spec from supplied hints.`,
  };
}

/**
 * Build the user-layer Oauth2AuthCodeSpec for a two_layer skill. Resolution order:
 * explicit `userLayerEndpoints` → well-known registry → fail (never fabricate URLs).
 */
function buildUserLayerSpec(input: ParamsToAuthSpecInput): { spec: Oauth2AuthCodeSpec | null; reason: string } {
  const overrides = input.userLayerEndpoints ?? {};
  const wellKnown = lookupWellKnownProvider(input.providerName);

  const authorizeUrl = overrides.authorizeUrl ?? wellKnown?.endpoints.authorizeUrl;
  const tokenUrl = overrides.tokenUrl ?? wellKnown?.endpoints.tokenUrl;
  const refreshUrl = overrides.refreshUrl ?? wellKnown?.endpoints.refreshUrl;
  const revokeUrl = overrides.revokeUrl ?? wellKnown?.endpoints.revokeUrl;

  if (authorizeUrl === undefined || tokenUrl === undefined) {
    return {
      spec: null,
      reason: `Two-layer skills need user-layer authorize + token URLs, but provider "${input.providerName}" is not in the well-known registry. Pass userLayerEndpoints explicitly.`,
    };
  }

  const scopes = input.userLayerScopes ?? wellKnown?.scopes;
  const pkce = input.userLayerPkce ?? wellKnown?.pkce ?? true;

  const userLayer: Oauth2AuthCodeSpec = {
    kind: 'oauth2_auth_code',
    provider: {
      name: wellKnown?.displayName ?? input.providerName.trim(),
      ...(input.homepageUrl !== undefined ? { homepageUrl: input.homepageUrl } : {}),
      ...(input.docsUrl !== undefined ? { docsUrl: input.docsUrl } : {}),
    },
    endpoints: {
      authorizeUrl,
      tokenUrl,
      ...(refreshUrl !== undefined ? { refreshUrl } : {}),
      ...(revokeUrl !== undefined ? { revokeUrl } : {}),
    },
    ...(scopes !== undefined && scopes.length > 0 ? { scopes } : {}),
    pkce,
    ...(wellKnown?.authorizeParams !== undefined ? { authorizeParams: wellKnown.authorizeParams } : {}),
    clientCreds:
      input.userLayerFields !== undefined && input.userLayerFields.length > 0
        ? input.userLayerFields
        : DEFAULT_CLIENT_CRED_FIELDS,
    ...(wellKnown?.apiHosts !== undefined ? { declaredApiHosts: wellKnown.apiHosts } : {}),
  };

  return {
    spec: userLayer,
    reason:
      wellKnown !== undefined
        ? `Synthesized userLayer from well-known provider "${input.providerName}".`
        : 'Synthesized userLayer from explicit overrides.',
  };
}

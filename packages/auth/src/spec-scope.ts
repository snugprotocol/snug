/**
 * requireApprovedSpecScope — the typed wall between proposals and tokens (AL-04
 * plan B1/AC12).
 *
 * The wizard flow order is PINNED: review → putAuthSpec → approveAuthSpec → ONLY
 * THEN credential collection / mint / OAuth start. This helper is how that order
 * becomes structural: every `SpecScope` the wizard passes to `OAuthService` is read
 * from a `snug_auth_specs` row asserted `status === 'approved'` — never built from a
 * proposal-derived union. Without it, `SpecScope.allowedHosts` is caller-supplied
 * and `deriveAuthAllowedHosts` auto-includes the tokenUrl host, so a poisoned
 * tokenUrl always satisfies its own proposal's ceiling; the review wall does nothing
 * unless it is ORDERED before the POST.
 */

import { AUTH_SPEC_STATUS } from '@snugprotocol/protocol';
import type { NetSpecReader } from './connected-fetch.js';
import { SnugAuthError, type SpecScope } from './oauth-service.js';

/**
 * Read the app's `snug_auth_specs` row and return its scope — the ROW's frozen
 * `allowedHosts`, never a derived union. Throws `SnugAuthError('spec_not_approved')`
 * for a missing, `unapproved`, or `imported_unapproved` row (fail closed: the
 * credential/mint step is unreachable until the user approves — B1).
 */
export async function requireApprovedSpecScope(reader: NetSpecReader, appId: string): Promise<SpecScope> {
  const row = await reader.getAuthSpec(appId);
  if (row === undefined) {
    throw new SnugAuthError(`no auth spec exists for app '${appId}' — nothing is approved`, 'spec_not_approved');
  }
  if (row.status !== AUTH_SPEC_STATUS.approved) {
    throw new SnugAuthError(
      `auth spec for app '${appId}' is '${row.status}' — approval must complete before credentials are touched`,
      'spec_not_approved',
    );
  }
  return { appId, spec: row.spec, allowedHosts: row.allowedHosts };
}

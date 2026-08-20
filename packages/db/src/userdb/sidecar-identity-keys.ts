// The host-side sidecar identity directory's slice of the `snug_settings` namespace
// (TASK-20260820-host-pseudonymisation, threat-model R-9).
//
// The directory holds third-party identities (contact names and jids) harvested from
// sidecar response bodies at the playground's `sidecarAppFetch` seat, so the LLM egress
// scrub can redact them from any sidecar-connected app's provider-bound payloads. It is a
// namespaced settings KEY rather than a new `snug_` table for exactly the ADR-0036 D2
// reason app-settings-keys.ts records: a table is a spec-normative portable-format change
// (`USERDB_SCHEMA_VERSION` bump + migration + spec-changelog entry), and this store is
// host-internal privacy machinery, not portable-format material.
//
// This module is the ONE definition of the key (lessons.md 2026-08-03: shared literals
// fork when "roughly specified"). Its writers: the playground's `state/sidecarIdentity.ts`
// (harvest) and `userdb.ts` (the revoke-wipe — the row is DELETED when the last approved
// sidecar-ceiling connection goes away, because a persisted third-party-PII asset must
// not outlive the connection that justified it; owner decision 2026-08-20).

/** `snug_settings` key holding the harvested identity directory as a JSON string array. */
export const SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY = 'sidecarIdentityDirectory';

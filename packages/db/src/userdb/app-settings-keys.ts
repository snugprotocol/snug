// The per-app slice of the `snug_settings` namespace (TASK-20260817).
//
// `snug_settings` is a hub-level key/value table holding GLOBAL settings — `mode`,
// `provider`, `model`, `localUrl`, `needsEndpointConfirm`. The per-app model pick joins
// it under a namespaced `appModel:<appId>` key rather than becoming a column on
// `snug_apps` (ADR-0036 D2): a column would need a `USERDB_SCHEMA_VERSION` bump, an
// `addColumnIfMissing` migration and a spec-changelog entry, for one nullable string.
//
// This module is the ONE definition of the key shape, mirroring `auth-secrets.ts` and
// for the same reason (lessons.md 2026-08-03: shared literals fork when "roughly
// specified" — two agents invented `x-snug-csrf` vs `x-csrf-token` and integrated
// dead-on-arrival). Both writers import from here: the playground's `state/appModel.ts`
// reads and writes the row, and `deleteApp`'s cascade removes it. If those two ever
// spelled the key differently, the symptom would be a pick that survives its own app's
// deletion and then silently applies to a REUSED app id.

/** The `appModel:` namespace prefix — exported so a hydrating reader can scan for it. */
export const APP_MODEL_SETTING_PREFIX = 'appModel:';

/**
 * `appModel:<appId>` — the model this one app routes its LLM calls to. Absent means the
 * app INHERITS the global `model` setting (and inherits it live), which is why clearing
 * a pick deletes the row rather than storing an empty string.
 */
export function appModelSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${APP_MODEL_SETTING_PREFIX}${appId}`;
}

/**
 * The appId a settings key names, or `undefined` if the key is not a per-app model row.
 * Hydration uses this instead of a loose `startsWith`, so global keys (`model`,
 * `provider`, `mode`) can never be read as though they were app ids.
 */
export function appIdFromModelSettingKey(key: string): string | undefined {
  if (!key.startsWith(APP_MODEL_SETTING_PREFIX)) return undefined;
  const appId = key.slice(APP_MODEL_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

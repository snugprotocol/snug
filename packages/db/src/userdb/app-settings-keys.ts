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

/** The `appProvider:` namespace prefix (TASK-20260821-ui-polish). */
export const APP_PROVIDER_SETTING_PREFIX = 'appProvider:';

/**
 * `appProvider:<appId>` — the LLM provider this one app routes to, written TOGETHER with
 * `appModel:<appId>` by the selector (a pin is a pin — a model row without its provider
 * would strand a foreign model id on whatever the default provider later becomes).
 * Absent means the app follows the resolved default provider, live.
 */
export function appProviderSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${APP_PROVIDER_SETTING_PREFIX}${appId}`;
}

/** The appId a settings key names, or `undefined` if the key is not a per-app provider row. */
export function appIdFromProviderSettingKey(key: string): string | undefined {
  if (!key.startsWith(APP_PROVIDER_SETTING_PREFIX)) return undefined;
  const appId = key.slice(APP_PROVIDER_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

/** The `appRenamed:` namespace prefix (TASK-20260821-ui-polish). */
export const APP_RENAMED_SETTING_PREFIX = 'appRenamed:';

/**
 * `appRenamed:<appId>` — the USER renamed this app, so the announce path must stop
 * refreshing `display_name` from the app's self-description (`recordAppMeta` reads this
 * through the playground's renamed-apps store). Absence means the app's own announced
 * name flows into the row as it always has; clearing a rename deletes the marker.
 */
export function appRenamedSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${APP_RENAMED_SETTING_PREFIX}${appId}`;
}

/** The appId a settings key names, or `undefined` if the key is not a rename marker. */
export function appIdFromRenamedSettingKey(key: string): string | undefined {
  if (!key.startsWith(APP_RENAMED_SETTING_PREFIX)) return undefined;
  const appId = key.slice(APP_RENAMED_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

/** The `starterVersion:` namespace prefix (TASK-20260820-starter-updates, ADR-0045 §6). */
export const STARTER_VERSION_SETTING_PREFIX = 'starterVersion:';

/**
 * `starterVersion:<appId>` — the starter version an installed starter copy is on,
 * written by the install and update acts. Absent means the copy predates versioning and
 * readers derive: newest-pinned bytes equal to the bundle ⇒ the current bundled version,
 * else 1. The same per-app-row-in-a-shared-namespace shape as `appModel:` above, with
 * the same obligation: `deleteApp`'s cascade removes it, or a missed key silently
 * applies to a REUSED app id.
 */
export function starterVersionSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${STARTER_VERSION_SETTING_PREFIX}${appId}`;
}

/** The appId a settings key names, or `undefined` if the key is not a starter-version row. */
export function appIdFromStarterVersionSettingKey(key: string): string | undefined {
  if (!key.startsWith(STARTER_VERSION_SETTING_PREFIX)) return undefined;
  const appId = key.slice(STARTER_VERSION_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

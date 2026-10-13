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

import type { OwnWriteAuthority } from '@snugprotocol/protocol';

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

// ------------------------------------------------ app sharing (TASK-20260904, ADR-0063)

/** The `sharedBundle:` namespace prefix. */
export const SHARED_BUNDLE_SETTING_PREFIX = 'sharedBundle:';

/**
 * `sharedBundle:<appId>` — the content id (`appBundleId`) of the bundle this shared
 * install currently reflects. Written by install and by update; read to decide whether a
 * re-received bundle of the same lineage is an UPDATE (ids differ) or already current
 * (ids equal) — identity, never html byte-equality, so a docs-only re-share is offered
 * (lesson 2026-08-21). One row per app ⇒ equality-deleted in `deleteApp`'s cascade.
 */
export function sharedBundleSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${SHARED_BUNDLE_SETTING_PREFIX}${appId}`;
}

/** The appId a settings key names, or `undefined` if the key is not a shared-bundle marker. */
export function appIdFromSharedBundleSettingKey(key: string): string | undefined {
  if (!key.startsWith(SHARED_BUNDLE_SETTING_PREFIX)) return undefined;
  const appId = key.slice(SHARED_BUNDLE_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

/** The `shareLink:` namespace prefix. */
export const SHARE_LINK_SETTING_PREFIX = 'shareLink:';

/**
 * `shareLink:<appId>:<linkId>` — the PUBLIC record of a link the user minted for this app
 * (`{ id, expiresAt }`); the revoke token and the decryption key live in `snug_secrets`
 * under `share:<linkId>`, which hub-origin sync and default exports never carry. MANY rows
 * per app, so the cascade is a prefix delete on `shareLink:<appId>:` with the same
 * `!`-escaping the `auth:` prefix uses.
 */
export function shareLinkSettingKey(appId: string, linkId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  if (linkId.length === 0) throw new Error('linkId must be non-empty');
  return `${shareLinkSettingPrefixFor(appId)}${linkId}`;
}

/** The per-app prefix every `shareLink:` row of one app shares — the cascade's LIKE pattern base. */
export function shareLinkSettingPrefixFor(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${SHARE_LINK_SETTING_PREFIX}${appId}:`;
}

/**
 * The AGENT install-source prefix (TASK-20260905-binding-a-artifacts AC8, ADR-0065 §6): an
 * app the user's own agent handed in as a bundle block embedded in a Claude artifact.
 * `agent:<lineage>` cannot spell `share:` or `starter:` (the lineage is a UUID). Homed here
 * — beside the tombstone key — because `deleteApp` (userdb.ts) needs it and userdb.ts
 * cannot import app-bundle.ts (which imports userdb.ts); app-bundle.ts re-exports it.
 */
export const AGENT_INSTALL_SOURCE_PREFIX = 'agent:';

/**
 * The STARTER install-source prefix (`starter:<folder>`, the starter catalogue's installs) —
 * homed beside the agent and share prefixes so every reader of an install source (the starter
 * modules, the Hub, the access consent sheet's provenance line) spells it ONCE
 * (TASK-20261010-cross-app-access W6 finding 15).
 */
export const STARTER_INSTALL_SOURCE_PREFIX = 'starter:';

export function agentInstallSource(lineage: string): string {
  return `${AGENT_INSTALL_SOURCE_PREFIX}${lineage}`;
}

/** The `agentDismissed:` namespace prefix (TASK-20260905-binding-a-artifacts AC8). */
export const AGENT_DISMISSED_SETTING_PREFIX = 'agentDismissed:';

/**
 * `agentDismissed:<lineage>` — the bundle id an `agent:`-installed app reflected when the
 * user DELETED it. Keyed by LINEAGE, not app id (the app row is gone), and written inside
 * `deleteApp`'s transaction: without it the block still embedded in the artifact page would
 * re-install the app on the next boot (plan review A6). A NEW bundle id from the agent
 * installs again — the user deleted an app, not their agent's right to hand one in.
 */
export function agentDismissedSettingKey(lineage: string): string {
  if (lineage.length === 0) throw new Error('lineage must be non-empty');
  return `${AGENT_DISMISSED_SETTING_PREFIX}${lineage}`;
}

/** The lineage a settings key names, or `undefined` if the key is not a tombstone. */
export function lineageFromAgentDismissedSettingKey(key: string): string | undefined {
  if (!key.startsWith(AGENT_DISMISSED_SETTING_PREFIX)) return undefined;
  const lineage = key.slice(AGENT_DISMISSED_SETTING_PREFIX.length);
  return lineage.length === 0 ? undefined : lineage;
}

/** The `sharedApp:` namespace prefix — the "shared with you" shelf (NOT app-scoped). */
export const SHARED_APP_SETTING_PREFIX = 'sharedApp:';

/**
 * `sharedApp:<bundleId>` — a received bundle the user chose to keep on the shelf (its JSON
 * text, plus receipt metadata). Keyed by CONTENT id, so the same bundle received twice is
 * one row. Not per-app — nothing installed owns it — so `deleteApp` owes it nothing; the
 * row is removed by dismiss or by install.
 */
export function sharedAppSettingKey(bundleId: string): string {
  if (bundleId.length === 0) throw new Error('bundleId must be non-empty');
  return `${SHARED_APP_SETTING_PREFIX}${bundleId}`;
}

/** The bundleId a settings key names, or `undefined` if the key is not a shelf row. */
export function bundleIdFromSharedAppSettingKey(key: string): string | undefined {
  if (!key.startsWith(SHARED_APP_SETTING_PREFIX)) return undefined;
  const bundleId = key.slice(SHARED_APP_SETTING_PREFIX.length);
  return bundleId.length === 0 ? undefined : bundleId;
}

// ------------------------------- scheduled tasks (TASK-20261009-scheduling-framework, ADR-0074 §2)
//
// The scheduler's record lives in `snug_settings` too (SPEC §8.1: host state that is
// neither app data nor a grant is a namespaced settings row — no new table, no v7). Five
// namespaces; the first three are keyed by TASK, the last two by APP. The accessors in
// `schedules.ts`, `deleteApp`'s cascade and the import reconciliation are the three
// writers, and all three spell every key through here. Note that `schedule:`,
// `scheduleRuns:` and `schedulerState` share their first eight letters: the parsers
// below test the FULL prefix, so a runs row can never be read as a task.

/** The `schedule:` namespace prefix — one row per task. */
export const SCHEDULE_SETTING_PREFIX = 'schedule:';

/** `schedule:<taskId>` — the task itself (`scheduledTaskSchema` JSON). */
export function scheduleSettingKey(taskId: string): string {
  if (taskId.length === 0) throw new Error('taskId must be non-empty');
  return `${SCHEDULE_SETTING_PREFIX}${taskId}`;
}

/** The taskId a settings key names, or `undefined` if the key is not a task row. */
export function taskIdFromScheduleSettingKey(key: string): string | undefined {
  if (!key.startsWith(SCHEDULE_SETTING_PREFIX)) return undefined;
  const taskId = key.slice(SCHEDULE_SETTING_PREFIX.length);
  return taskId.length === 0 ? undefined : taskId;
}

/** The `scheduleRuns:` namespace prefix — one bounded row per task. */
export const SCHEDULE_RUNS_SETTING_PREFIX = 'scheduleRuns:';

/**
 * `scheduleRuns:<taskId>` — the task's run history as ONE JSON array, newest first,
 * bounded by entries, by bytes per task and by bytes across every task (ADR-0074 §2).
 * One row per task, so it is equality-deleted beside its task.
 */
export function scheduleRunsSettingKey(taskId: string): string {
  if (taskId.length === 0) throw new Error('taskId must be non-empty');
  return `${SCHEDULE_RUNS_SETTING_PREFIX}${taskId}`;
}

/** The taskId a settings key names, or `undefined` if the key is not a runs row. */
export function taskIdFromScheduleRunsSettingKey(key: string): string | undefined {
  if (!key.startsWith(SCHEDULE_RUNS_SETTING_PREFIX)) return undefined;
  const taskId = key.slice(SCHEDULE_RUNS_SETTING_PREFIX.length);
  return taskId.length === 0 ? undefined : taskId;
}

/**
 * `schedulerState` — the ONE row for the scheduler itself: the reconcile watermark, the
 * global pause and the daily counters (`schedulerStateSchema`). A fixed key, not a
 * namespace: there is one scheduler per file.
 */
export const SCHEDULER_STATE_SETTING_KEY = 'schedulerState';

/** The `scheduleDeclined:` namespace prefix. */
export const SCHEDULE_DECLINED_SETTING_PREFIX = 'scheduleDeclined:';

/**
 * `scheduleDeclined:<appId>:<hash>` — the user said *Not now* to this app's suggestion,
 * identified by `proposalHash()` over its semantic fields (ADR-0074 §4). MANY rows per
 * app, so the cascade is a prefix delete on `scheduleDeclinedSettingPrefixFor(appId)`
 * with the same `!`-escaping the `auth:` and `shareLink:` prefixes use. Dropped whole on
 * an untrusted import: these are the user's own answers, not something a file carries in.
 */
export function scheduleDeclinedSettingKey(appId: string, hash: string): string {
  if (hash.length === 0) throw new Error('hash must be non-empty');
  return `${scheduleDeclinedSettingPrefixFor(appId)}${hash}`;
}

/** The per-app prefix every `scheduleDeclined:` row of one app shares — the cascade's LIKE pattern base. */
export function scheduleDeclinedSettingPrefixFor(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${SCHEDULE_DECLINED_SETTING_PREFIX}${appId}:`;
}

/** The `scheduleMuted:` namespace prefix. */
export const SCHEDULE_MUTED_SETTING_PREFIX = 'scheduleMuted:';

/**
 * `scheduleMuted:<appId>` — *Stop suggestions from this app* (two declines, or the
 * explicit choice). Absent means not muted, which is why clearing DELETES the row. One
 * row per app ⇒ equality-deleted in `deleteApp`'s cascade.
 */
export function scheduleMutedSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${SCHEDULE_MUTED_SETTING_PREFIX}${appId}`;
}

/** The appId a settings key names, or `undefined` if the key is not a mute marker. */
export function appIdFromScheduleMutedSettingKey(key: string): string | undefined {
  if (!key.startsWith(SCHEDULE_MUTED_SETTING_PREFIX)) return undefined;
  const appId = key.slice(SCHEDULE_MUTED_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

// ------------------------- access between apps (TASK-20261010-cross-app-access, ADR-0075 §2, §7)
//
// The access record lives in `snug_settings` too (spec 1.1 §8.1's carve-out: a hub
// implementing Part VI persists under these keys). Four namespaces: grants are keyed by
// GRANT, the history by SOURCE app (the source keeps the history — ADR-0075 §7), declines
// and the mute by READER app. The accessors in `access.ts`, `deleteApp`'s cascade and the
// import reconciliation are the three writers, and all three spell every key through here.
// Every parser tests the FULL prefix (colon included), so `accessGrant:` and `accessLog:`
// can never be read as each other, nor `accessMuted:` as `accessDeclined:`.

/** The `accessGrant:` namespace prefix — one row per grant. */
export const ACCESS_GRANT_SETTING_PREFIX = 'accessGrant:';

/** `accessGrant:<grantId>` — the grant itself (`accessGrantSchema` JSON). */
export function accessGrantSettingKey(grantId: string): string {
  if (grantId.length === 0) throw new Error('grantId must be non-empty');
  return `${ACCESS_GRANT_SETTING_PREFIX}${grantId}`;
}

/** The grantId a settings key names, or `undefined` if the key is not a grant row. */
export function grantIdFromAccessGrantSettingKey(key: string): string | undefined {
  if (!key.startsWith(ACCESS_GRANT_SETTING_PREFIX)) return undefined;
  const grantId = key.slice(ACCESS_GRANT_SETTING_PREFIX.length);
  return grantId.length === 0 ? undefined : grantId;
}

/** The `accessLog:` namespace prefix — one bounded row per SOURCE app. */
export const ACCESS_LOG_SETTING_PREFIX = 'accessLog:';

/**
 * `accessLog:<sourceAppId>` — the history of every read of this app's data and every
 * grant's lifecycle, as ONE JSON array, newest first, bounded by entries, by bytes per
 * source and by bytes across every source. One row per app ⇒ equality-deleted in
 * `deleteApp`'s cascade.
 */
export function accessLogSettingKey(sourceAppId: string): string {
  if (sourceAppId.length === 0) throw new Error('sourceAppId must be non-empty');
  return `${ACCESS_LOG_SETTING_PREFIX}${sourceAppId}`;
}

/** The source app a settings key names, or `undefined` if the key is not a history row. */
export function sourceAppIdFromAccessLogSettingKey(key: string): string | undefined {
  if (!key.startsWith(ACCESS_LOG_SETTING_PREFIX)) return undefined;
  const sourceAppId = key.slice(ACCESS_LOG_SETTING_PREFIX.length);
  return sourceAppId.length === 0 ? undefined : sourceAppId;
}

/** The `accessDeclined:` namespace prefix. */
export const ACCESS_DECLINED_SETTING_PREFIX = 'accessDeclined:';

/**
 * `accessDeclined:<readerAppId>:<hash>` — the user said *don't allow* to this reader's ask,
 * identified by `accessRequestHash()` over its semantic fields (ADR-0075 §4); the value is
 * `{ purpose, hints, at }` so the reader's sheet can list it with *allow…*. MANY rows per
 * reader, so the cascade is a prefix delete on `accessDeclinedSettingPrefixFor(readerAppId)`
 * (the `scheduleDeclined:` shape). Dropped whole on an untrusted import.
 */
export function accessDeclinedSettingKey(readerAppId: string, hash: string): string {
  if (hash.length === 0) throw new Error('hash must be non-empty');
  return `${accessDeclinedSettingPrefixFor(readerAppId)}${hash}`;
}

/** The per-reader prefix every `accessDeclined:` row of one app shares — the cascade's LIKE pattern base. */
export function accessDeclinedSettingPrefixFor(readerAppId: string): string {
  if (readerAppId.length === 0) throw new Error('readerAppId must be non-empty');
  return `${ACCESS_DECLINED_SETTING_PREFIX}${readerAppId}:`;
}

/** The `accessMuted:` namespace prefix. */
export const ACCESS_MUTED_SETTING_PREFIX = 'accessMuted:';

/**
 * `accessMuted:<readerAppId>` — *stop asking*: this reader's `request` is declined without a
 * strip. Absent means not muted, which is why clearing DELETES the row. One row per app ⇒
 * equality-deleted in `deleteApp`'s cascade; dropped on an untrusted import.
 */
export function accessMutedSettingKey(readerAppId: string): string {
  if (readerAppId.length === 0) throw new Error('readerAppId must be non-empty');
  return `${ACCESS_MUTED_SETTING_PREFIX}${readerAppId}`;
}

/** The reader app a settings key names, or `undefined` if the key is not a mute marker. */
export function readerAppIdFromAccessMutedSettingKey(key: string): string | undefined {
  if (!key.startsWith(ACCESS_MUTED_SETTING_PREFIX)) return undefined;
  const readerAppId = key.slice(ACCESS_MUTED_SETTING_PREFIX.length);
  return readerAppId.length === 0 ? undefined : readerAppId;
}

// ---------------------- the undo journal and the wants (TASK-20261010-host-broker PR-3, D-PR3-7, D-Q11)
//
// Two more one-row-per-app namespaces beside the four above. `accessUndo:<targetAppId>` is the
// TARGET's journal of the rows each brokered write changed (spec 1.2 §22.4) — the target keeps
// it, as it keeps its history; `accessWants:<appId>` is an app's builder-time declaration of
// what it WILL ask for (ADR-0076 §11) — since PR-5 (D-PR5-2) a host-derived mirror of the app's
// CURRENT html head, written at every admission and re-derived on every import (`access-wants.ts`).
// Both are the user's own device state: `deleteApp` equality-deletes each; an untrusted import drops
// the journal, and every import re-derives the wants.

/** The `accessUndo:` namespace prefix — one row per TARGET app. */
export const ACCESS_UNDO_SETTING_PREFIX = 'accessUndo:';

/** `accessUndo:<targetAppId>` — the target's undo journal: ONE JSON array of `accessUndoEntrySchema` entries, newest first. */
export function accessUndoSettingKey(targetAppId: string): string {
  if (targetAppId.length === 0) throw new Error('targetAppId must be non-empty');
  return `${ACCESS_UNDO_SETTING_PREFIX}${targetAppId}`;
}

/** The target app a settings key names, or `undefined` if the key is not a journal row. */
export function targetAppIdFromAccessUndoSettingKey(key: string): string | undefined {
  if (!key.startsWith(ACCESS_UNDO_SETTING_PREFIX)) return undefined;
  const targetAppId = key.slice(ACCESS_UNDO_SETTING_PREFIX.length);
  return targetAppId.length === 0 ? undefined : targetAppId;
}

/** The `accessWants:` namespace prefix — one row per app. */
export const ACCESS_WANTS_SETTING_PREFIX = 'accessWants:';

/** `accessWants:<appId>` — the app's declared asks (`accessWantsSchema` JSON), derived from its html — never written by hand. */
export function accessWantsSettingKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${ACCESS_WANTS_SETTING_PREFIX}${appId}`;
}

/** The app a settings key names, or `undefined` if the key is not a wants row. */
export function appIdFromAccessWantsSettingKey(key: string): string | undefined {
  if (!key.startsWith(ACCESS_WANTS_SETTING_PREFIX)) return undefined;
  const appId = key.slice(ACCESS_WANTS_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

// ---------------------- the imported marker (TASK-20261010-host-broker PR-5, D-PR5-9)
//
// `appProvenance:<appId>` records that this app ARRIVED WITH A FILE THE USER IMPORTED — an untrusted
// import carries `install_source` verbatim, so a file can forge `starter:`/`agent:`/`share:`, and the
// access provenance reads this marker instead (R-77). Written only by the untrusted import (for an app
// whose identity differs from the local one), kept by a trusted pull, never cleared by an edit;
// `deleteApp` equality-deletes it. The value's shape lives in `app-provenance.ts`.

/** The `appProvenance:` namespace prefix — one row per app. */
export const APP_PROVENANCE_SETTING_PREFIX = 'appProvenance:';

/** `appProvenance:<appId>` — the imported marker (`appProvenanceSchema` JSON). */
export function appProvenanceKey(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${APP_PROVENANCE_SETTING_PREFIX}${appId}`;
}

/** The app a settings key names, or `undefined` if the key is not an imported marker. */
export function appIdFromAppProvenanceKey(key: string): string | undefined {
  if (!key.startsWith(APP_PROVENANCE_SETTING_PREFIX)) return undefined;
  const appId = key.slice(APP_PROVENANCE_SETTING_PREFIX.length);
  return appId.length === 0 ? undefined : appId;
}

// ---------------------- the own undo journal (TASK-20261010-host-broker PR-4, D-PR4-3)
//
// `ownUndo:<appId>:<bucket>` keeps the rows an OWN write changed — one row per armed schedule
// (`<bucket>` = its task id) and one for the user's own approvals (`approval`) — so a schedule's
// bucket can refuse when full while the user's approvals never do. Host-internal; the user's own
// device state: `deleteApp` sweeps the app's prefix, `deleteScheduledTask` its bucket, and an
// untrusted import drops the namespace.

/** The `ownUndo:` namespace prefix. */
export const OWN_UNDO_SETTING_PREFIX = 'ownUndo:';

/** The bucket of the user's own approvals — spelled as the authority it journals, so a rename is a type error. */
export const OWN_UNDO_APPROVAL_BUCKET = 'approval' as const satisfies OwnWriteAuthority;

/** `ownUndo:<appId>:<bucket>` — one bucket's journal: ONE JSON array of `ownUndoEntrySchema` entries, newest first. `bucket` is `approval` or a task id. */
export function ownUndoKey(appId: string, bucket: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  if (bucket.length === 0) throw new Error('bucket must be non-empty');
  return `${ownUndoPrefixFor(appId)}${bucket}`;
}

/** `ownUndo:<appId>:` — every bucket of one app, for the `deleteApp` sweep (the `auth:` prefix's known limit: an app id holding a colon would over-match a sibling — unreachable with UUID ids). */
export function ownUndoPrefixFor(appId: string): string {
  if (appId.length === 0) throw new Error('appId must be non-empty');
  return `${OWN_UNDO_SETTING_PREFIX}${appId}:`;
}

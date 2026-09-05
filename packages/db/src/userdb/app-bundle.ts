// app-bundle.ts — the db half of app sharing (TASK-20260904-app-sharing, ADR-0063).
//
// Three acts over ONE app in the user file:
//
//   buildAppBundle       the sharer's side — lift the app out as a `snug-app-bundle/1`.
//   installAppFromBundle the recipient's side — a starter install, minus first-party trust.
//   updateAppFromBundle  the recipient re-receives a newer bundle of a lineage they hold —
//                        ADR-0045's "update · keeps your data" act with a bundle as source.
//
// WHAT NEVER LEAVES (C1). `buildAppBundle` reads exactly: the app row's identity columns,
// the CURRENT version's html and contract, the registered schema's DDL, the docs the
// caller named, and each non-revoked connection's `requirement` — never `snug_secrets`,
// never a grant column (`status`, `allowed_hosts`, `approved_at`, pending, `imported`,
// `confidence`), never an earlier version, never a thread, never a settings row. The
// C1 test is a byte scan over the serialized bundle for exactly those things.
//
// TWO STRIPS ON THE WAY OUT. A `lanHost` requirement's `declaredApiHosts` is the address
// the SHARER's router assigned (collected in their wizard) — it is stripped so the
// recipient collects their own, exactly as a starter's `connection.json` ships. A
// `userLayer` is registry-synthesized and never travels (the bundle schema refuses it).
//
// THE REGISTRY IS NOT HERE. `packages/db` must not import `packages/auth` (auth depends on
// db), so the "bare borrower" reduction — export only `slot / provider / kind / hosts`
// for a provider the registry knows, so the RECIPIENT's registry substitutes its own
// pinned seats — is a caller-supplied `reduceConnection` hook the playground fills. The
// same boundary is why install does not call admission itself: `putDeclaredConnection`
// runs the INJECTED gate (the composition root wires the full one), on the `shared`
// channel, for every slot, and a refusal drops that slot with a note — never the install.
//
// INSTALL IS A STARTER INSTALL. `installApp` (find-or-create on `share:<lineage>`, v1
// pinned) → contract on v1 → DDL replay (a failure here is an install failure and the
// half-made app is removed — an app whose first query is "no such table" must not ship)
// → docs absent-only → connections declared. `install_source` is minted HERE from the
// bundle's UUID-charset lineage, so a bundle can never claim a starter identity.

import {
  APP_BUNDLE_DOC_SLUG_RULE,
  APP_BUNDLE_FORMAT,
  CONTAINER,
  appBundleSchema,
  type AppBundle,
  type AppBundleDoc,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';

import { sharedBundleSettingKey } from './app-settings-keys.js';
import { ConnectionNotAdmitted, USERDB_ERROR_CODES, UserDbError, type AppDocRecord, type UserDb } from './userdb.js';

// ----------------------------------------------------------------------- build

export interface BuildAppBundleOptions {
  /** Doc slugs to include, in this order. Slugs that cannot travel (charset) are skipped and reported. */
  docs: readonly string[];
  /** Stamped into `producer.hubVersion` when known. */
  hubVersion?: string;
  /**
   * Per-connection rewrite applied AFTER the two mandatory strips. The playground supplies
   * the registry-aware bare-borrower reduction here; absent, requirements export verbatim.
   */
  reduceConnection?: (requirement: ConnectionRequirement) => ConnectionRequirement;
  /** Clock seam for tests. */
  now?: () => Date;
}

export const SHARE_INSTALL_SOURCE_PREFIX = 'share:';

export function shareInstallSource(lineage: string): string {
  return `${SHARE_INSTALL_SOURCE_PREFIX}${lineage}`;
}

/**
 * The AGENT provenance (TASK-20260905-binding-a-artifacts AC8, ADR-0065 §6): an app the
 * user's own agent handed in as a bundle block embedded in a Claude artifact. Installed as
 * an OWNED app (editable, versioned — the builder-chat semantics, not the shared shelf's)
 * under `agent:<lineage>`, which cannot spell `share:` or `starter:` (the lineage is a
 * UUID, enforced by the bundle schema). Prose in the spec, not schema: `install_source`
 * is free TEXT with a partial unique index.
 */
export const AGENT_INSTALL_SOURCE_PREFIX = 'agent:';

export function agentInstallSource(lineage: string): string {
  return `${AGENT_INSTALL_SOURCE_PREFIX}${lineage}`;
}

/** Which channel a bundle arrives on. `'shared'` is ADR-0063's (the default, byte-for-byte); `'agent'` is the artifact hand-in. */
export type BundleProvenance = 'shared' | 'agent';

const INSTALL_NOTE: Record<BundleProvenance, string> = {
  shared: 'installed from a shared app',
  agent: 'installed by your agent',
};
const UPDATE_NOTE: Record<BundleProvenance, string> = {
  shared: 'shared update',
  agent: 'updated by your agent',
};

/**
 * D4 — nothing in Binding A may claim connected apps. Under `agent` a bundle that carries
 * connections is a HARD refusal at the boundary: nothing installs, nothing updates, and the
 * code names it — never "skip the declarations and land the rest", which would quietly
 * drop the one signal that says this app wanted network access (plan review S1).
 */
function refuseAgentConnections(bundle: AppBundle, provenance: BundleProvenance): void {
  if (provenance === 'agent' && bundle.connections.length > 0) {
    throw new UserDbError(
      USERDB_ERROR_CODES.AGENT_CONNECTIONS_REFUSED,
      `"${bundle.app.displayName}" asks for ${bundle.connections.length} connection(s) — connected apps are not available inside an artifact, so this hand-in was refused`,
    );
  }
}

/**
 * Has the user re-authored their copy since the newest pinned (factory / hand-in) version
 * landed? The ONE predicate the artifact boot and the run header share (plan review A3):
 * `current ≠ newest pinned` AND the html differs — a revert to the pinned bytes reads as
 * unedited. An app with no pinned version at all is never "edited" (nothing to compare).
 */
export function isEditedCopy(db: UserDb, appId: string): boolean {
  const app = db.getApp(appId);
  if (app === undefined) return false;
  const newestPinned = db
    .listAppVersions(appId)
    .filter((v) => v.pinned)
    .sort((a, b) => b.version - a.version)[0];
  if (newestPinned === undefined || newestPinned.version === app.currentVersion) return false;
  return db.getAppHtml(appId) !== db.getAppHtml(appId, newestPinned.version);
}

/**
 * Strip the two seats a bundle must never carry from a stored requirement. Pure: returns a
 * new object; the stored row is untouched.
 */
export function stripRequirementForShare(requirement: ConnectionRequirement): ConnectionRequirement {
  const { userLayer: _userLayer, ...rest } = requirement;
  if (rest.lanHost !== undefined) {
    const { declaredApiHosts: _collected, ...withoutAddress } = rest;
    return withoutAddress;
  }
  return rest;
}

export async function buildAppBundle(db: UserDb, appId: string, options: BuildAppBundleOptions): Promise<AppBundle> {
  const app = db.getApp(appId);
  if (app === undefined) {
    throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" not found`);
  }
  // The registered schema is written back from the app runtime on flush; read it current.
  await db.flush();

  const html = db.getAppHtml(appId);
  if (html === undefined) {
    throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" has no current version`);
  }
  const contract = db.getRuntimeContract(appId, app.currentVersion);
  const schema = db.getAppSchema(appId);
  const ddl = schema?.objects.map((object) => object.ddl) ?? [];

  const stored = new Map(db.listAppDocs(appId).map((doc) => [doc.slug, doc] as const));
  const docs: { slug: string; title?: string; content: string }[] = [];
  for (const slug of options.docs) {
    const doc = stored.get(slug);
    if (doc === undefined || !APP_BUNDLE_DOC_SLUG_RULE.test(slug) || doc.content.trim() === '') continue;
    docs.push({ slug, ...(doc.title !== undefined ? { title: doc.title } : {}), content: doc.content });
  }

  const reduce = options.reduceConnection ?? ((requirement: ConnectionRequirement) => requirement);
  const connections = db
    .listConnections(appId)
    .filter((row) => row.status !== 'revoked')
    .map((row) => reduce(stripRequirementForShare(row.requirement)));

  const candidate = {
    format: APP_BUNDLE_FORMAT,
    lineage: appId,
    sharedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(options.hubVersion !== undefined ? { producer: { hubVersion: options.hubVersion } } : {}),
    app: {
      displayName: app.displayName,
      ...(app.description !== undefined ? { description: app.description } : {}),
      ...(app.iconEmoji !== undefined ? { iconEmoji: app.iconEmoji } : {}),
      ...(app.iconColor !== undefined ? { iconColor: app.iconColor } : {}),
      usesDb: app.usesDb,
    },
    html,
    ...(contract !== undefined ? { contract } : {}),
    ...(ddl.length > 0 ? { schema: { ddl } } : {}),
    ...(docs.length > 0 ? { docs } : {}),
    connections,
  };
  // The bundle we hand out must be the bundle a recipient will accept — validate at the
  // same boundary they will, so an app that cannot travel (a doc over the cap, a DDL
  // entry that is not a CREATE) fails HERE with a named issue instead of at the far end.
  const parsed = appBundleSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new UserDbError(
      USERDB_ERROR_CODES.TOO_LARGE,
      `this app cannot be bundled: ${first?.path.map(String).join('.') ?? ''} ${first?.message ?? 'invalid'}`.trim(),
    );
  }
  return parsed.data;
}

// --------------------------------------------------------------------- install

export interface AppBundleInstallOptions {
  /** The receiver-computed content id (`appBundleId`), recorded as `sharedBundle:<appId>`. */
  bundleId: string;
  /** The channel the bundle arrived on; absent = `'shared'` (ADR-0063, unchanged). */
  provenance?: BundleProvenance;
}

export interface RefusedSlot {
  slot: string;
  reason: string;
}

export type AppBundleInstallResult =
  | { status: 'installed'; appId: string; refusedSlots: RefusedSlot[] }
  | { status: 'already-installed'; appId: string; refusedSlots: [] };

/** A display name no other app in the file carries (the rename rule, case-insensitive). */
function uniqueDisplayName(db: UserDb, wanted: string): string {
  const taken = new Set(db.listApps().map((app) => app.displayName.trim().toLowerCase()));
  if (!taken.has(wanted.trim().toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n++) {
    // Trim the NAME, never the suffix — an 80-char name sliced after suffixing would
    // shed the suffix and come back a duplicate (Gate-5 finding 14).
    const suffix = ` (${n})`;
    const candidate = `${wanted.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }
  return `${wanted} (${crypto.randomUUID().slice(0, 8)})`.slice(0, 80);
}

/**
 * Seed docs ABSENT-ONLY (ADR-0035's rule): a doc the recipient already holds under that
 * slug is theirs and is never overwritten by a re-install or an update.
 */
export function seedDocsAbsentOnly(db: UserDb, appId: string, docs: readonly AppBundleDoc[]): string[] {
  const existing = new Set(db.listAppDocs(appId).map((doc: AppDocRecord) => doc.slug));
  const seeded: string[] = [];
  for (const doc of docs) {
    if (existing.has(doc.slug)) continue;
    db.putAppDoc(appId, doc.slug, { ...(doc.title !== undefined ? { title: doc.title } : {}), content: doc.content });
    seeded.push(doc.slug);
  }
  return seeded;
}

/**
 * Declare connections on the `shared` channel — the ONLY provenance this writer knows. A
 * row that is `approved` (a grant the user reviewed) or `revoked` (the user's "no") is
 * never touched: only an absent or still-`declared` row is written. The injected admission
 * gate runs inside `putDeclaredConnection`; a refusal drops that slot with its reason.
 */
export function declareSharedConnections(
  db: UserDb,
  appId: string,
  requirements: readonly ConnectionRequirement[],
): RefusedSlot[] {
  const refused: RefusedSlot[] = [];
  for (const requirement of requirements) {
    const existing = db.getConnection(appId, requirement.slot);
    if (existing !== undefined && existing.status !== 'declared') continue;
    try {
      db.putDeclaredConnection(appId, requirement.slot, requirement, 'shared');
    } catch (error) {
      const reason =
        error instanceof ConnectionNotAdmitted
          ? error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
          : error instanceof Error
            ? error.message
            : String(error);
      refused.push({ slot: requirement.slot, reason });
    }
  }
  return refused;
}

export async function installAppFromBundle(
  db: UserDb,
  bundle: AppBundle,
  options: AppBundleInstallOptions,
): Promise<AppBundleInstallResult> {
  const provenance = options.provenance ?? 'shared';
  const installSource = provenance === 'agent' ? agentInstallSource(bundle.lineage) : shareInstallSource(bundle.lineage);
  const existing = db.getAppByInstallSource(installSource);
  if (existing !== undefined) {
    return { status: 'already-installed', appId: existing.appId, refusedSlots: [] };
  }
  refuseAgentConnections(bundle, provenance);

  const app = db.installApp({
    displayName: uniqueDisplayName(db, bundle.app.displayName),
    ...(bundle.app.description !== undefined ? { description: bundle.app.description } : {}),
    ...(bundle.app.iconEmoji !== undefined ? { iconEmoji: bundle.app.iconEmoji } : {}),
    ...(bundle.app.iconColor !== undefined ? { iconColor: bundle.app.iconColor } : {}),
    usesDb: bundle.app.usesDb,
    html: bundle.html,
    note: INSTALL_NOTE[provenance],
    installSource,
  });

  try {
    if (bundle.contract !== undefined) db.putRuntimeContract(app.appId, 1, bundle.contract);
    if (bundle.schema !== undefined && bundle.schema.ddl.length > 0) {
      await db.applyAppDdl(app.appId, [...bundle.schema.ddl]);
    }
  } catch (error) {
    // The app is half-made: no schema means every data query fails. Remove it so the
    // failure is honest ("could not install") rather than a broken tile.
    await db.deleteApp(app.appId);
    const detail = error instanceof Error ? error.message : String(error);
    throw new UserDbError(USERDB_ERROR_CODES.DDL_FAILED, `could not install "${bundle.app.displayName}": ${detail}`);
  }

  seedDocsAbsentOnly(db, app.appId, bundle.docs ?? []);
  const refusedSlots = declareSharedConnections(db, app.appId, bundle.connections);
  db.setSetting(sharedBundleSettingKey(app.appId), options.bundleId);
  return { status: 'installed', appId: app.appId, refusedSlots };
}

// ---------------------------------------------------------------------- update

export type AppBundleUpdateResult =
  | { status: 'updated'; version: number; refusedSlots: RefusedSlot[] }
  | { status: 'already-current' };

/**
 * ADR-0045's update act with a bundle as the source. New html lands as a PINNED version
 * carrying the bundle's contract (one synchronous `saveAppVersion` call, so there is no
 * durable state where the new html runs under the old contract); DDL is replayed
 * per-statement with "already exists" skipped (the recipient's tables hold THEIR rows and
 * are never dropped); docs seed absent-only; only still-`declared` connection rows
 * refresh. App data, secrets, chat, the recipient's own docs and every approved grant are
 * untouched by construction. Idempotent on the bundle id.
 */
export async function updateAppFromBundle(
  db: UserDb,
  appId: string,
  bundle: AppBundle,
  options: AppBundleInstallOptions,
): Promise<AppBundleUpdateResult> {
  const provenance = options.provenance ?? 'shared';
  const app = db.getApp(appId);
  if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" not found`);
  // The target rule per channel. `shared`: the installed copy of this lineage, only.
  // `agent`: that, OR the app the bundle was LIFTED FROM (`buildAppBundle` sets
  // `lineage = appId`) — a kit-built app or an installed starter the agent edited and
  // handed back takes the update in place, its own install_source untouched (plan review
  // A4). A `share:` copy is never an agent target.
  const isTarget =
    provenance === 'agent'
      ? app.installSource === agentInstallSource(bundle.lineage) || app.appId === bundle.lineage
      : app.installSource === shareInstallSource(bundle.lineage);
  if (!isTarget) {
    throw new UserDbError(
      USERDB_ERROR_CODES.NOT_FOUND,
      `app "${appId}" is not an installed copy of this bundle's lineage`,
    );
  }
  if (db.getSetting(sharedBundleSettingKey(appId)) === options.bundleId) return { status: 'already-current' };
  // Before any DDL: a refused hand-in leaves the app exactly as it was.
  refuseAgentConnections(bundle, provenance);

  // DDL FIRST (Gate-5 finding 5): CREATE-only statements are additive and harmless under
  // the old html, so a failure at statement N leaves the OLD code current with a few
  // extra objects — never new code on a partial schema. Only once every statement has
  // applied (or was already there) does the new version land.
  for (const statement of bundle.schema?.ddl ?? []) {
    try {
      await db.applyAppDdl(appId, [statement]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already exists/i.test(message)) continue;
      throw new UserDbError(USERDB_ERROR_CODES.DDL_FAILED, `could not update "${app.displayName}": ${message}`);
    }
  }

  const meta = db.saveAppVersion(appId, bundle.html, UPDATE_NOTE[provenance], undefined, {
    pinned: true,
    ...(bundle.contract !== undefined ? { contract: bundle.contract } : {}),
  });

  seedDocsAbsentOnly(db, appId, bundle.docs ?? []);
  // Under `agent` the list is empty by the refusal above — the `shared` writer is never
  // reached with an agent bundle, so no `shared` provenance row can be minted by a hand-in.
  const refusedSlots = provenance === 'agent' ? [] : declareSharedConnections(db, appId, bundle.connections);
  db.setSetting(sharedBundleSettingKey(appId), options.bundleId);
  return { status: 'updated', version: meta.version, refusedSlots };
}

// ----------------------------------------------------------------------- sniff

/**
 * `'user-file-wrapper'` (TASK-20260905-binding-a-artifacts AC6): a user file wrapped as
 * JSON for an artifact export — `{"format":"snug-user-file/1",…}` with `format` as the FIRST
 * key by contract, so the sniff reads a fixed prefix and never parses. Decoded and
 * re-sniffed by `unwrapUserFile` (user-file-wrapper.ts) before any import.
 */
export type SnugFileKind = 'user-file' | 'app-bundle' | 'user-file-wrapper' | 'unknown';

export const USER_FILE_WRAPPER_FORMAT = 'snug-user-file/1' as const;
/** The canonical wrapper's first bytes — `wrapUserFile` emits exactly this; the sniff reads exactly this. */
export const USER_FILE_WRAPPER_PREFIX = `{"format":"${USER_FILE_WRAPPER_FORMAT}"`;

const SQLITE_MAGIC = 'SQLite format 3\0';
const BOM = [0xef, 0xbb, 0xbf] as const;

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * What kind of `.snug` file is this? Decided from the HEAD of the bytes — a SQLite
 * database (`SQLite format 3\0`), a protected one (`SNUGENC1`), or a JSON bundle (first
 * non-whitespace byte `{`, after an optional BOM). Everything else is `unknown`. This is
 * the one reader the desktop open path, the Settings pickers and the link receiver share,
 * so a user file can never be offered as an app and a bundle can never reach the
 * replace-your-file confirm (ADR-0063 §2).
 */
export function sniffSnugFile(bytes: Uint8Array): SnugFileKind {
  if (startsWith(bytes, SQLITE_MAGIC) || startsWith(bytes, CONTAINER.MAGIC)) return 'user-file';
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) i = 3;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      i++;
      continue;
    }
    if (b !== 0x7b) return 'unknown';
    return startsWithAt(bytes, i, USER_FILE_WRAPPER_PREFIX) ? 'user-file-wrapper' : 'app-bundle';
  }
  return 'unknown';
}

function startsWithAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length - offset < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

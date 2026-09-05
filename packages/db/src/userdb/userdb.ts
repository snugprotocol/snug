// The per-USER database (ADR-0007 + ADR-0010): one sql.js handle over one file holding
// hub tables (apps, versions, schema registry, docs, chat, settings, secrets, profile,
// sync config) plus per-app data as REAL namespaced tables (`app_<token>__<name>`).
// One shared handle + one write-back pipeline serve both the typed CRUD API and the
// runner-facing DbDriver (F7 — two independent writers of one file are forbidden by
// construction). The driver face COMPOSES the existing per-app driver with a
// MATERIALIZER PersistenceBackend: at run, an app's objects are replayed into the app's
// own database (natural names — physical isolation preserved); at rest, table rows live
// under `app_<token>__<name>` and the registry carries the runtime sqlite_master DDL
// VERBATIM. DDL bodies are never string-rewritten; at-rest names come from SQLite's own
// ALTER TABLE … RENAME under legacy_alter_table (a pure name swap). Objects with names
// outside the normative rule fail the write-back CLOSED (previous rest state retained,
// surfaced via onAppPersistError) — nothing is ever built from an unvalidated name.
//
// Unlike the per-app driver (errors-as-data at the frame boundary), the typed CRUD API
// throws UserDbError — it is an in-process API, mirroring useAppDB's throwing contract.
import initSqlJs from 'sql.js';
import {
  decryptContainer,
  encryptContainer,
  isEncryptedContainer,
  openFileKey,
  resealContainer,
  type Secrets as ContainerSecrets,
} from '../crypto/container.js';
import type { BindParams, Database, SqlJsStatic } from 'sql.js';
import {
  APP_KV_TABLE,
  AUTH_MAX_SLOTS_PER_APP,
  CONNECTION_PROVENANCES,
  CONNECTION_STATUS,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  SIDECAR_SYMBOLIC_HOST,
  USERDB_CONNECTIONS_TABLE,
  USERDB_DDL,
  USERDB_FILE,
  USERDB_LEGACY_FILE,
  USERDB_INDEX_DDL,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
  appDataToken,
  appRestTableName,
  canonicalRequirementHash,
  canonicalRuntimeContract,
  connectionRequirementSchema,
  deriveConnectionAllowedHosts,
  hostSetEquals,
  isValidAppObjectName,
  parseRuntimeContract,
  runtimeContractSchema,
  type AppSchemaJson,
  type AppSchemaObject,
  type AuthSpecStatus,
  type ConnectionProvenance,
  type ConnectionRequirement,
  type ConnectionStatus,
  type DbRequestFrame,
  type RuntimeContract,
} from '@snugprotocol/protocol';
import { authAppSecretPrefix, authConnectionSlotPrefix, isLegacyAppSecretKey } from './auth-secrets.js';
import {
  appIdFromModelSettingKey,
  appIdFromProviderSettingKey,
  appIdFromRenamedSettingKey,
  appModelSettingKey,
  appProviderSettingKey,
  appRenamedSettingKey,
  starterVersionSettingKey,
  shareLinkSettingPrefixFor,
  sharedBundleSettingKey,
} from './app-settings-keys.js';
import { SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY } from './sidecar-identity-keys.js';
import { base64ToBytes } from '../base64.js';
import {
  KV_TABLE_DDL,
  createDbDriver,
  sqlJsInitConfig,
  forbiddenStatementReason,
  isRowModifyingStatement,
  isSqlTailEmpty,
  normalizeCell,
  type DbPersistence,
  type SnugDbDriver,
} from '../driver.js';
import { namespaceToFileName } from '../namespace.js';
import { detectPersistenceBackend, type PersistenceBackend } from '../persistence.js';

export const USERDB_ERROR_CODES = {
  /** The whole-file cap (MAX_USERDB_BYTES or the injected override) would be exceeded. */
  TOO_LARGE: 'USERDB_TOO_LARGE',
  /** Import payload is not an openable Snug user DB (magic/open-check/version failed). */
  BAD_IMPORT: 'USERDB_BAD_IMPORT',
  /**
   * The payload is a protected container and no supplied secret opened it. Distinct
   * from BAD_IMPORT because the file is FINE — it needs a passphrase, and telling the
   * user their backup is broken would be both false and frightening.
   */
  LOCKED_IMPORT: 'USERDB_LOCKED_IMPORT',
  /** The referenced app/version/thread does not exist. */
  NOT_FOUND: 'USERDB_NOT_FOUND',
  /**
   * `deleteAppVersion` aimed at a pinned factory version. Pins are what `resetToFactory`
   * restores and what the ADR-0045 starter-update vouch chain compares against — ALL of
   * them are protected, not only the newest (owner decision 2026-08-21).
   */
  VERSION_PINNED: 'USERDB_VERSION_PINNED',
  /** `deleteAppVersion` aimed at the version the app is currently running. */
  VERSION_CURRENT: 'USERDB_VERSION_CURRENT',
  /** The UserDb was closed. */
  CLOSED: 'USERDB_CLOSED',
  /** An app runtime object name violates the normative naming rule (write-back refused). */
  INVALID_NAME: 'USERDB_INVALID_NAME',
  /** applyAppDdl failed; the app runtime was restored to its pre-batch snapshot. */
  DDL_FAILED: 'USERDB_DDL_FAILED',
  /** An auth spec failed strict validation at the write boundary (ingest fail-closed). */
  INVALID_AUTH_SPEC: 'USERDB_INVALID_AUTH_SPEC',
  /** An ordinary auth-spec update tried to change the frozen derived host union (plan D5). */
  HOST_FREEZE: 'USERDB_HOST_FREEZE',
  /** A connection requirement failed strict validation at the write boundary (AC10). */
  INVALID_CONNECTION_REQUIREMENT: 'USERDB_INVALID_CONNECTION_REQUIREMENT',
  /** An accessor was called against a connection row whose status forbids that write (AC10/AC12). */
  CONNECTION_WRITE_RULE: 'USERDB_CONNECTION_WRITE_RULE',
  /** A write was aimed at a REVOKED row; reconnect is an explicit wizard act (AC10). */
  CONNECTION_REVOKED: 'USERDB_CONNECTION_REVOKED',
  /** The app already holds `AUTH_MAX_SLOTS_PER_APP` declared slots (AC11, fold S-M1). */
  CONNECTION_SLOT_CAP: 'USERDB_CONNECTION_SLOT_CAP',
  /** A requirement's own `slot` disagrees with the slot it is being written to (review MINOR). */
  CONNECTION_SLOT_MISMATCH: 'USERDB_CONNECTION_SLOT_MISMATCH',
  /** Channel admission refused the requirement at the persist boundary (review MAJOR-2). */
  CONNECTION_NOT_ADMITTED: 'USERDB_CONNECTION_NOT_ADMITTED',
  /**
   * `scratchRun` could not build the throwaway copy of the app runtime (snapshot export or
   * its base64 decode failed). Distinct from a SQL error inside the scratch DB, which is
   * reported per statement as DATA — this one means the sandbox itself never existed, so
   * the caller must not read "no rows" as an answer.
   */
  SCRATCH_UNAVAILABLE: 'USERDB_SCRATCH_UNAVAILABLE',
} as const;

export type UserDbErrorCode = (typeof USERDB_ERROR_CODES)[keyof typeof USERDB_ERROR_CODES];

export class UserDbError extends Error {
  constructor(
    readonly code: UserDbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserDbError';
  }
}


/**
 * Thrown when a connection accessor is aimed at a row whose STATUS forbids that write —
 * `putDeclaredConnection` against an `approved` row (a changed requirement must stage
 * through `stagePendingRequirement`, parent §3), or `stagePendingRequirement` against a
 * row that is not `approved` (a `declared` row is simply replaced).
 *
 * Named separately from `ConnectionRevokedError` because the two carry different
 * REMEDIES, and the wizard renders them differently: this one means "use the other
 * accessor", while a tombstone means "ask the user to reconnect, and show them the date".
 * A single generic error would force the UI to string-match the message to tell them
 * apart.
 */
export class ConnectionWriteRuleViolation extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly status: ConnectionStatus,
    remedy: string,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_WRITE_RULE,
      `connection "${appId}/${slot}" is ${status}; ${remedy}`,
    );
    this.name = 'ConnectionWriteRuleViolation';
  }
}

/**
 * Thrown when any write is aimed at a REVOKED row. Revocation is deliberately terminal
 * for the automatic channels: the row survives as a TOMBSTONE so the wizard can tell the
 * user "you revoked this on <date>" instead of silently re-offering a clean-looking
 * connection, and only an explicit reconnect act may move it forward.
 */
export class ConnectionRevokedError extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly revokedAt: string | undefined,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_REVOKED,
      `connection "${appId}/${slot}" was revoked${revokedAt !== undefined ? ` on ${revokedAt}` : ''}; reconnecting is an explicit user act, not an automatic re-declaration`,
    );
    this.name = 'ConnectionRevokedError';
  }
}

/**
 * Thrown when an app already holds `AUTH_MAX_SLOTS_PER_APP` rows and a NEW slot is
 * declared (fold S-M1). `guardAddedBytes` bounds bytes per write, not row count, so
 * without this a hostile or broken build emits unbounded declared rows.
 *
 * Two boundary rules are load-bearing and are pinned by tests rather than left to
 * reading: REPLACING an existing slot never counts (otherwise the legitimate R3
 * re-inference path breaks exactly at the cap), and REVOKED tombstones DO count (they
 * are precisely what a flooding attacker leaves behind, and the revoke path keeps the
 * row by design).
 */
export class ConnectionSlotCapExceeded extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly cap: number,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_SLOT_CAP,
      `app "${appId}" already declares ${cap} connection slots (AUTH_MAX_SLOTS_PER_APP); refusing to add "${slot}"`,
    );
    this.name = 'ConnectionSlotCapExceeded';
  }
}

/**
 * Thrown when a requirement's OWN `slot` disagrees with the slot it is being written to
 * (review MINOR).
 *
 * Not a cosmetic mismatch. The two identities are read by different halves of the system:
 * the COLUMN is the primary key, the credential-key prefix (`auth:<appId>:<slot>:*`) and
 * what revoke/wipe targets; the REQUIREMENT JSON is what the canonical hash covers, what
 * `requirement_version` tracks, and what the review screen renders. Allowing them to
 * diverge means the user reviews and approves a requirement labelled `otherslot` while
 * the runtime serves — and later wipes — `realslot`.
 *
 * Refused at every accessor that can introduce the split rather than normalized to the
 * column: silently rewriting the requirement would change bytes the caller is about to
 * hash and show, which is how a "helpful" coercion becomes a review-integrity bug.
 */
export class ConnectionSlotMismatch extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly requirementSlot: unknown,
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_SLOT_MISMATCH,
      `connection "${appId}/${slot}" carries a requirement for slot ${JSON.stringify(requirementSlot)}; the requirement's own slot must match the slot it is written to`,
    );
    this.name = 'ConnectionSlotMismatch';
  }
}

/**
 * Thrown when channel ADMISSION refuses a requirement at the persist boundary
 * (review MAJOR-2).
 *
 * Distinct from `INVALID_CONNECTION_REQUIREMENT`, which means "this is not a well-formed
 * requirement". This one means "this is well-formed, and this CHANNEL may not make this
 * claim" — a provenance judgement, not a shape judgement. The wizard renders them
 * differently: a shape error is a build bug to report, while a refused admission is a
 * trust decision to show the user.
 */
export class ConnectionNotAdmitted extends UserDbError {
  constructor(
    readonly appId: string,
    readonly slot: string,
    readonly provenance: string,
    readonly issues: readonly { path: string; message: string }[],
  ) {
    super(
      USERDB_ERROR_CODES.CONNECTION_NOT_ADMITTED,
      `connection "${appId}/${slot}" was refused admission on the '${provenance}' channel: ${
        issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'no reason given'
      }`,
    );
    this.name = 'ConnectionNotAdmitted';
  }
}

/**
 * The ADMISSION SEAM (review MAJOR-2).
 *
 * WHY A SEAM RATHER THAN A DIRECT CALL. `@snugprotocol/auth` already depends on
 * `@snugprotocol/db`, and the admission logic needs the well-known-provider REGISTRY,
 * which lives in `packages/auth`. Importing it here would close an import cycle. So the
 * dependency is inverted instead: packages/db owns the RULE ("nothing persists
 * unadmitted") and calls whatever gate it holds, while packages/auth — which owns the
 * registry — supplies the gate at construction.
 *
 * The seam is deliberately NOT an "enable admission" flag. There is no configuration that
 * turns the rule off; the only choice is WHICH gate implements it, and the default
 * (`defaultAdmissionGate`) is installed when a caller says nothing. That distinction is
 * the whole point of the finding: the previous guard was correct and simply never
 * reached, so a fix whose enforcement depended on the caller remembering to opt in would
 * reproduce it one seam over.
 *
 * Structurally identical to `AdmissionResult` in packages/auth, restated here so the two
 * packages agree by SHAPE without either importing the other.
 */
export interface ConnectionAdmissionResult {
  ok: boolean;
  /** The requirement AFTER registry substitution — what must be persisted on a borrow hit. */
  requirement: unknown;
  issues: readonly { path: string; message: string }[];
}

export type ConnectionAdmissionGate = (
  requirement: unknown,
  context: { channel: string; appId: string; slot: string },
) => ConnectionAdmissionResult;

/**
 * The gate installed when a caller injects none — and the reason this fix does not
 * reproduce the finding it closes.
 *
 * It enforces the half of admission that needs NO registry: the AC5 userLayer channel
 * rule. `userLayer` is a registry-SYNTHESIZED seat, so the judgement is made entirely on
 * provenance — "did this come from the registry channel?" — and needs nothing from the
 * provider table. That half is therefore implemented here, where the persist path can
 * always reach it, rather than left to injection that a caller might forget.
 *
 * The registry-BORROW half (name/host substitution) genuinely cannot live here: it reads
 * the well-known-provider table in packages/auth, which packages/db must not import. A
 * second copy of that table here would be a divergent security rule, which is worse than
 * one honest hand-off. So the composition root injects the full gate
 * (`admitConnectionRequirement`), and this default holds the floor until it does —
 * failing CLOSED on the seat that motivated AC5, never silently admitting everything.
 */
export const defaultAdmissionGate: ConnectionAdmissionGate = (requirement, context) => {
  const record =
    typeof requirement === 'object' && requirement !== null && !Array.isArray(requirement)
      ? (requirement as Record<string, unknown>)
      : undefined;
  if (record !== undefined && record['userLayer'] !== undefined && context.channel !== 'registry') {
    return {
      ok: false,
      requirement,
      issues: [
        {
          path: 'userLayer',
          message: `userLayer is registry-synthesized only — the '${context.channel}' channel may not declare one`,
        },
      ],
    };
  }
  return { ok: true, requirement, issues: [] };
};

/** A write-back failure the service recovered from by keeping the previous rest state. */
export interface AppPersistErrorEvent {
  namespace: string;
  code: string;
  message: string;
}

export interface AppRecord {
  appId: string;
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  usesDb: boolean;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Dedup identity for marketplace/starter installs (`starter:<folder>`); absent for built apps. */
  installSource?: string;
}

export interface AppVersionMeta {
  version: number;
  note?: string;
  createdAt: string;
  htmlBytes: number;
  /** Pinned versions (the factory version) are never pruned. */
  pinned: boolean;
}

export interface ChatThread {
  threadId: string;
  appId?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Pinned messages (the bootstrap turn) survive any pruning for the life of the app. */
  pinned: boolean;
  /** Structured sidecar: artifact card refs, wire text — JSON, shape owned by the client. */
  meta?: unknown;
}

export interface AppDocRecord {
  slug: string;
  title?: string;
  content: string;
  updatedAt: string;
}

/**
 * One `snug_connections` row (Dynamic Auth v2) — the REQUIREMENT/GRANT split in one
 * record. Credential VALUES never appear here; they live in `snug_secrets` under
 * `auth:<appId>:<slot>:<fieldKey>` (ADR-0014, byte-for-byte unchanged).
 */
export interface ConnectionRow {
  appId: string;
  slot: string;
  /** What the app NEEDS. Validated strictly at every write boundary. */
  requirement: ConnectionRequirement;
  /**
   * An edit's CHANGED requirement, staged while the grant keeps serving `requirement`
   * and its old frozen hosts (fold B2). Present + `status === 'approved'` is the
   * DERIVED "needs re-approval" state — never a fourth status.
   */
  pendingRequirement?: ConnectionRequirement;
  /** Bumped on every persisted replacement whose canonical hash differs (fold T-mn3). */
  requirementVersion: number;
  provenance: ConnectionProvenance;
  /** Display-only inference confidence; never read by a gating decision. */
  confidence?: number;
  status: ConnectionStatus;
  /**
   * The FROZEN host ceiling for `approved` rows — the union derived AT approval and
   * displayed in full to the user first. For `declared`/`revoked` rows it is the union
   * derived from the current requirement (a preview; injection is barred by `status`).
   */
  allowedHosts: string[];
  /** True for a row that arrived through `importUserDb` and was re-reviewed (fold T-M5). */
  imported: boolean;
  approvedAt?: string;
  /** Tombstone stamp. The row SURVIVES revocation so the wizard can show this date. */
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Caller-supplied provenance for `importUserDb`.
 *
 * `trustedOrigin` says "these bytes came from the user's OWN configured sync origin" —
 * true only for the recovery restore and the sync pull, which fetch from that origin
 * themselves. A file the user picked off disk is NEVER trusted, however empty the hub is:
 * emptiness cannot tell a restore from a hostile donor, but the caller can (R-M2).
 *
 * Deliberately absent-means-untrusted, so a new call site that forgets it gets the safe
 * behavior rather than the convenient one.
 */
export interface UserDbImportOptions {
  trustedOrigin?: boolean;
  /**
   * Secrets for a PROTECTED payload (ADR-0043). Every path that admits foreign bytes
   * — sync pull-merge, applyRemote, recovery restore, and the UI's file import —
   * arrives here, so this one seam is what makes a protected file portable between
   * devices. Absent or non-matching secrets REJECT; they never clobber local state.
   */
  secrets?: ContainerSecrets;
}

/** What `importUserDb` surfaces about the auth reconciliation passes (plan D5/N1). */
export interface UserDbImportReport {
  /** Structurally unusable `snug_connections` rows that were dropped, with reasons. */
  droppedConnections: Array<{ appId: string; slot: string; reason: string }>;
  /**
   * Imported runtime contracts that were REFUSED because they are not byte-identical to a
   * contract this hub already knows (ADR-0018, AC-F1-7). A contract is rendered into the
   * SYSTEM slot of every runtime turn, so an imported one is a system-authority claim from
   * an untrusted file — same doctrine as the connection reconciliation above.
   */
  droppedRuntimeContracts: Array<{ appId: string; version: number }>;
}

/** One statement submitted to `scratchRun` — SQL plus its bound parameters. */
export interface ScratchStatement {
  sql: string;
  params?: readonly unknown[];
}

/**
 * Per-statement outcome of a scratch run. `rows`/`columns` for reads, `changes` for
 * writes (the dry-run preview), `error` instead of both when the statement was refused or
 * failed — errors are DATA here, exactly as they are in the driver.
 */
export interface ScratchStatementResult {
  rows?: unknown[][];
  columns?: string[];
  /** Rows the statement would affect. The number D8 shows the user and re-checks at execute. */
  changes?: number;
  /** True when `rows` was cut by the row or byte cap (AC-F2-6). */
  truncated?: boolean;
  /** Rows the query actually produced, present only when `truncated`. */
  totalRows?: number;
  error?: string;
}

export interface ScratchRunResult {
  statements: ScratchStatementResult[];
}

/**
 * Row cap for a scratch read before results re-enter the LLM context (AC-F2-6). Generous
 * enough for a real answer ("my expenses last quarter"), far below what would blow a
 * context window.
 */
export const MAX_QUERY_ROWS = 200;

/** Byte cap on a scratch read's rows — the guard for few-but-huge rows the row cap misses. */
export const MAX_QUERY_RESULT_BYTES = 32 * 1024;

export interface AppMigrationRecord {
  seq: number;
  ddl: string;
  appliedAt: string;
}

export interface InstallAppInput {
  appId?: string;
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  usesDb?: boolean;
  html: string;
  note?: string;
  /** When present, install is find-or-create on this identity (unique at the DB level). */
  installSource?: string;
}

/** Options for `saveAppVersion` — see the interface doc (ADR-0045). */
export interface SaveAppVersionOptions {
  /** Land the new version as a pinned factory snapshot (never pruned; `resetToFactory` target). */
  pinned?: boolean;
  /** Override the copy-forward: this version carries exactly this contract. */
  contract?: RuntimeContract;
}

export interface UserDb {
  readonly persistence: DbPersistence;
  /** Runner-facing DbDriver over materialized per-app databases (inject into SnugAppFrame). */
  readonly driver: SnugDbDriver;

  installApp(input: InstallAppInput): AppRecord;
  /**
   * Append a new version. The runtime contract is COPIED FORWARD from
   * `contractSourceVersion` (default: the app's current version) so an ordinary edit never
   * strands it — ADR-0018 D2(i). Revert/reset pass the version they restore.
   *
   * `opts` exists for the starter-update act (ADR-0045): `pinned` lands the new version
   * as a factory snapshot the retention prune never drops, and `contract` OVERRIDES the
   * copy-forward with the starter's own contract for this version — validated at this
   * boundary exactly like `putRuntimeContract`, and written in the same synchronous call
   * so there is no durable state where updated HTML runs under the pre-update contract.
   */
  saveAppVersion(
    appId: string,
    html: string,
    note?: string,
    contractSourceVersion?: number,
    opts?: SaveAppVersionOptions,
  ): AppVersionMeta;
  /** Patch display metadata (announce overlay, usesDb observation) — versions untouched. */
  updateAppMeta(
    appId: string,
    patch: Partial<Pick<AppRecord, 'displayName' | 'description' | 'iconEmoji' | 'iconColor' | 'usesDb'>>,
  ): void;
  listApps(): AppRecord[];
  /**
   * Delete an installed app and cascade to every referencing row in one transaction:
   * its `app_<token>__*` data tables, schema, migrations, docs, versions, threads and
   * their chat messages, then the app row. IGNORES `pinned` — the factory version and
   * bootstrap message go too. Throws NOT_FOUND for an unknown app; rolls back whole on
   * any failure. Marks dirty and flushes, so the delete reaches the exported bytes.
   */
  deleteApp(appId: string): Promise<void>;
  getApp(appId: string): AppRecord | undefined;
  getAppByInstallSource(source: string): AppRecord | undefined;
  getAppHtml(appId: string, version?: number): string | undefined;
  listAppVersions(appId: string): AppVersionMeta[];
  /**
   * Delete ONE stored version row (TASK-20260821-ui-polish AC3/AC4).
   *
   * Refusals, in guard order: unknown app/version → NOT_FOUND (current is always
   * MAX(version), so a too-high number reads as unknown, never as "current"); a pinned
   * factory version → VERSION_PINNED (every pin — reset-to-factory and the starter-update
   * vouch chain both address pins); the running version → VERSION_CURRENT.
   */
  deleteAppVersion(appId: string, version: number): void;
  revertApp(appId: string, toVersion: number): AppVersionMeta;
  /** Copy-forward to the NEWEST pinned factory version (ADR-0045: starter updates land as new pinned rows; no pinned row is ever pruned). */
  resetToFactory(appId: string): AppVersionMeta;

  /**
   * The runtime contract for `version` (default: the app's current version), or undefined
   * when the app has none or the stored row is unusable (ADR-0018).
   *
   * NEVER THROWS on a bad row: an app whose contract is corrupt must run on the lean
   * generic layers, not fail its turn (AC-F1-4).
   */
  getRuntimeContract(appId: string, version?: number): RuntimeContract | undefined;
  /**
   * Write (or, with `undefined`, clear) the runtime contract on a specific version row.
   * Validates through `runtimeContractSchema` — an over-bound contract is rejected at this
   * boundary, because this is the write side of the only artifact that reaches the SYSTEM
   * slot of a runtime turn.
   */
  putRuntimeContract(appId: string, version: number, contract: RuntimeContract | undefined): void;

  /**
   * Run statements against a THROWAWAY copy of the app's materialized runtime DB
   * (ADR-0019 D7). Reads answer data questions; writes execute against the copy and die
   * with it, which is what makes the data lane read-only BY CONSTRUCTION and gives D8's
   * approval flow a truthful dry-run preview (`changes` per statement).
   *
   * There is no `readonly` flag on purpose: a flag is a knob a call site can get wrong,
   * and nothing here can reach the real file at all.
   *
   * Throws NOT_FOUND for an unknown app. SQL errors are reported per statement as DATA;
   * a refused statement stops the batch.
   */
  scratchRun(appId: string, statements: readonly ScratchStatement[]): Promise<ScratchRunResult>;

  /** The app's registered schema (verbatim natural DDL), or undefined when it has none. */
  getAppSchema(appId: string): AppSchemaJson | undefined;
  /**
   * Hub-side execution layer for LLM-proposed DDL: applies the statements to the app's
   * materialized runtime atomically (all-or-nothing via snapshot restore), then
   * persists + registers the schema and appends the audit trail.
   */
  applyAppDdl(appId: string, statements: string[]): Promise<AppSchemaJson>;
  listAppMigrations(appId: string): AppMigrationRecord[];


  // ------------------------------------------------- connections (Dynamic Auth v2)
  //
  // The ONLY writers of `snug_connections`. Each is the sole legal author of one
  // transition, so "which accessor may I call?" is answerable from `status` alone —
  // that is what makes the write rules enforceable rather than conventional.

  /**
   * Insert, or replace an existing **`declared`** row — the legitimate R3 re-inference
   * path. THROWS `ConnectionWriteRuleViolation` on an `approved` row (a changed
   * requirement stages through `stagePendingRequirement`) and `ConnectionRevokedError`
   * on a tombstone. Enforces `AUTH_MAX_SLOTS_PER_APP` for NEW slots only.
   */
  putDeclaredConnection(
    appId: string,
    slot: string,
    requirement: unknown,
    provenance: ConnectionProvenance,
    opts?: { confidence?: number },
  ): ConnectionRow;
  /**
   * Stage an edit's changed requirement against an APPROVED row (fold B2): writes
   * `pending_requirement_json` and NOTHING else, so the grant keeps serving the exact
   * requirement and frozen hosts the user approved. THROWS on any other status.
   */
  stagePendingRequirement(appId: string, slot: string, requirement: unknown): ConnectionRow;
  /**
   * Wizard-only: freeze the derived host union into `allowed_hosts`, stamp `approved_at`,
   * status → `approved`. `allowedHosts` on the returned row is the COMPLETE list the
   * caller must have displayed to the user. Re-validates the stored requirement.
   */
  approveConnection(appId: string, slot: string): ConnectionRow;
  /**
   * The ONLY widening path: promote `pending_requirement_json` → `requirement_json`,
   * re-freeze the union, clear pending, stamp a NEW `approved_at`. Bumps
   * `requirement_version` when the promoted requirement differs canonically.
   */
  reapproveConnection(appId: string, slot: string): ConnectionRow;
  /**
   * status → `revoked`, `revoked_at` stamped, **row KEPT** as a tombstone, and the
   * credential slice `auth:<appId>:<slot>:*` wiped (slot-scoped — a sibling slot's
   * credentials survive).
   */
  revokeConnection(appId: string, slot: string): ConnectionRow;
  getConnection(appId: string, slot: string): ConnectionRow | undefined;
  /** Every row for one app, or every row in the DB when `appId` is omitted. Slot-ordered. */
  listConnections(appId?: string): ConnectionRow[];

  putAppDoc(appId: string, slug: string, doc: { title?: string; content: string }): void;
  getAppDoc(appId: string, slug: string): AppDocRecord | undefined;
  listAppDocs(appId: string): AppDocRecord[];
  deleteAppDoc(appId: string, slug: string): void;

  upsertThread(threadId: string, opts?: { appId?: string; title?: string }): void;
  appendChatMessage(
    threadId: string,
    role: ChatMessage['role'],
    content: string,
    opts?: { pinned?: boolean; meta?: unknown },
  ): ChatMessage;
  /** Marks an already-stored message as bootstrap (review F9: the v1-artifact turn). */
  pinChatMessage(id: number): void;
  /**
   * Replace one message's `meta`, leaving content and pinning alone (R-M5).
   *
   * Exists so a resolved data-write proposal persists its outcome: without it, a reload
   * re-renders an already-applied change as still awaiting approval. Narrow on purpose —
   * meta is the only mutable column, because rewriting a stored message's CONTENT would
   * let a later turn silently rewrite history the user already read.
   */
  updateChatMessageMeta(id: number, meta: unknown): void;
  /** Deletes unpinned messages beyond the newest `keepUnpinned`; pinned rows always survive. */
  pruneChatMessages(threadId: string, keepUnpinned: number): void;
  listThreads(): ChatThread[];
  getThread(threadId: string): ChatThread | undefined;
  listChatMessages(threadId: string): ChatMessage[];
  /**
   * Delete one conversation: the thread row and every message in it, pinned rows
   * included (the pin protects against PRUNING, not against the user's own delete —
   * the same rule the app cascade applies). Never touches the app the thread is pinned
   * to; a stale id is a no-op (TASK-20260903-build-thread-continuity AC5b, D4).
   */
  deleteThread(threadId: string): void;

  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
  /** Remove one settings row entirely — `setSetting(key, undefined)` stores JSON null. */
  deleteSetting(key: string): void;
  /** Every settings key, sorted — for namespaced-prefix readers (`sharedApp:`, `shareLink:`) that parse the key rather than trusting a prefix test. */
  listSettingKeys(): string[];
  /**
   * Every app that has PINNED a model, as `{ [appId]: modelId }` (TASK-20260817).
   * Apps that inherit the global `model` setting are simply absent — inheritance is an
   * absence, not a stored copy, so a later change to the default reaches them.
   *
   * Typed rather than left to callers because the `appModel:<appId>` key shape is a
   * shared contract (`app-settings-keys.ts`): a caller hand-rolling a `startsWith` scan
   * over `snug_settings` would read the global `model`/`mode`/`provider` rows as app ids.
   */
  listAppModels(): Record<string, string>;
  /** Pin one app to a model, or clear the pin (`undefined`) so the app inherits again. */
  setAppModel(appId: string, model: string | undefined): void;
  /**
   * Every app that has PINNED a provider, as `{ [appId]: provider }` — the sibling of
   * `listAppModels` (TASK-20260821): written together with the model pin, absent when the
   * app follows the resolved default provider.
   */
  listAppProviders(): Record<string, string>;
  /** Pin one app to a provider, or clear (`undefined`) so it follows the default again. */
  setAppProvider(appId: string, provider: string | undefined): void;
  /** Apps whose display name the USER set — the announce path must not clobber these. */
  listRenamedApps(): string[];
  /** Mark (or clear) the user-renamed flag for one app. */
  setAppRenamed(appId: string, renamed: boolean): void;
  getProfileField(key: string): unknown;
  setProfileField(key: string, value: unknown): void;
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
  getSyncConfig(key: string): unknown;
  setSyncConfig(key: string, value: unknown): void;

  /** Standalone `.sqlite` bytes of one app's data namespace (flushes the driver first). */
  deriveAppExport(namespace: string): Promise<Uint8Array | undefined>;
  /** Whole-file export. Default strips `snug_secrets` and VACUUMs so freed pages leak nothing. */
  exportUserDb(opts?: { includeSecrets?: boolean }): Promise<Uint8Array>;
  /**
   * Full replace with validated user-DB bytes (older schemas are migrated forward).
   * Runs the delta-aware auth-spec reconciliation pass (plan D5/N1) — pull-merge,
   * applyRemote, recovery restore, and UI import all inherit it through here.
   */
  importUserDb(bytes: Uint8Array, options?: UserDbImportOptions): Promise<UserDbImportReport>;

  /**
   * Seals bytes into this file's container, or `undefined` when the file is not
   * protected. Exposed so the sync loop can encrypt personal-origin payloads with the
   * SAME session key the write-back uses (ADR-0043, D5) — the loop therefore never
   * holds a passphrase, and pushes never re-key, so a second device that learned the
   * secret once keeps opening every later copy (AC20).
   */
  readonly sealForOrigin?: (bytes: Uint8Array) => Promise<Uint8Array>;

  /**
   * Turn protection ON for this file, or change/remove it (ADR-0043, AC13/AC14).
   *
   * Owned by the UserDb rather than exposed as a generic "overwrite the stored bytes"
   * seam, deliberately: a public whole-file write is a foot-gun that any future caller
   * could point at the user's database. Here the conversion is the only thing it can
   * do, and it reuses the SAME atomic write every ordinary save uses — desktop
   * temp+fsync+rename, OPFS A/B slot commit — so a crash mid-conversion leaves the
   * previous complete file in place. No bespoke second atomicity contract.
   *
   * Passing `undefined` removes protection and writes plaintext back.
   */
  protect(secrets: { passphrase: string; recoveryKey: string } | undefined): Promise<void>;

  flush(): Promise<void>;
  close(): Promise<void>;
}

export type OpenUserDbResult =
  | { status: 'ok'; userDb: UserDb }
  | {
      status: 'corrupt';
      quarantinedFile: string;
      message: string;
      /** Explicit caller decision (F6): start over with an empty DB, quarantine retained. */
      openFresh(): Promise<UserDb>;
    }
  | { status: 'unsupported'; foundVersion: number; message: string }
  /**
   * The file is a `SNUGENC1` container and no supplied secret opened it (ADR-0043).
   *
   * Deliberately NOT 'corrupt': nothing is quarantined, nothing is rewritten, and the
   * bytes on disk are untouched. A protected file is healthy — it is waiting for a
   * secret. Quarantining it would look, to its owner, exactly like losing it.
   */
  | { status: 'locked'; message: string };

export interface OpenUserDbOptions {
  backend?: PersistenceBackend;
  locateWasm?: (file: string) => string;
  /**
   * The sql.js engine as bytes (TASK-20260905-host-kit P4) — see `CreateDbDriverOptions`.
   * The user-db open is the FIRST initSqlJs caller in the playground, and sql.js memoizes
   * that first call, so the bytes must ride THIS option; they are also forwarded to the
   * inner per-app driver so both sites boot the same way.
   */
  wasmBinary?: ArrayBuffer | Uint8Array;
  persistDebounceMs?: number;
  /** Whole-file cap; defaults to the spec constant. Tests shrink it. */
  maxBytes?: number;
  /** Unpinned versions retained per app; defaults to the spec constant. */
  versionsRetained?: number;
  file?: string;
  /** Surfaced when a write-back fails closed (name gate, cap) — previous rest state retained. */
  onAppPersistError?: (event: AppPersistErrorEvent) => void;
  /**
   * Channel-admission gate consulted before ANY requirement is persisted (review MAJOR-2).
   * Defaults to `defaultAdmissionGate`; the composition root injects the full
   * registry-aware gate from packages/auth. There is no way to switch admission OFF —
   * see the `ConnectionAdmissionGate` note for why that is the seam's whole point.
   */
  admissionGate?: ConnectionAdmissionGate;
  /**
   * Secrets for a protected file. Absent (or not matching) yields `status: 'locked'`;
   * the caller collects a secret and opens again. Held only for the duration of the
   * open and the session's write-backs — never persisted anywhere, least of all into
   * `snug_secrets`, which lives inside the very file being decrypted (AC17).
   */
  secrets?: ContainerSecrets;
}

const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const SQLITE_MAGIC = 'SQLite format 3' + String.fromCharCode(0);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function readUserVersion(db: Database): number {
  const result = db.exec('PRAGMA user_version');
  const value = result[0]?.values[0]?.[0];
  return typeof value === 'number' ? value : 0;
}

/** `"…"`-quote an identifier. Table names are rule-validated BEFORE quoting; column names may be arbitrary. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function hasColumn(db: Database, table: string, column: string): boolean {
  const info = db.exec(`PRAGMA table_info(${table})`);
  return (info[0]?.values ?? []).some((row) => String(row[1]) === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, decl: string): void {
  if (!hasColumn(db, table, column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Forward-only migrations; index N migrates FROM version N. v0 → current applies the full DDL. */
const MIGRATIONS: ReadonlyArray<(db: Database) => void> = [
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
  // v1 → v2 (ADR-0010): STRUCTURAL only — blob app data is abandoned (owner-approved,
  // pre-launch). New tables/columns/index land; the oldest surviving version per app is
  // stamped as the factory version so the pin invariant holds for migrated files.
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    addColumnIfMissing(db, USERDB_TABLES.apps, 'install_source', 'TEXT');
    addColumnIfMissing(db, USERDB_TABLES.appVersions, 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, USERDB_TABLES.chatMessages, 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, USERDB_TABLES.chatMessages, 'meta', 'TEXT');
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
    db.run('DROP TABLE IF EXISTS snug_app_data');
    db.run(
      `UPDATE ${USERDB_TABLES.appVersions} SET pinned = 1 WHERE (app_id, version) IN
       (SELECT app_id, MIN(version) FROM ${USERDB_TABLES.appVersions} GROUP BY app_id)`,
    );
  },
  // v2 → v3 (AL-02, internal draft): additive only — `snug_auth_specs` lands via the
  // idempotent CREATE IF NOT EXISTS replay. No data movement; credential values were
  // never stored anywhere else.
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
  // v3 → v4 (TASK-20260810, Dynamic Auth v2): additive only — `snug_connections` lands
  // via the same idempotent replay. A bare replay is CORRECT here for the same reason it
  // was at v3 and for no other: v4 adds a whole NEW table, and `CREATE TABLE IF NOT
  // EXISTS` cannot alter an existing one. The day a migration needs to change an existing
  // table's shape, this pattern silently does nothing while `migrate()` stamps the new
  // version anyway (`:498`) — which is exactly the "the persisted version lied" failure
  // the self-heal guard below exists to catch. Adding columns needs `addColumnIfMissing`,
  // as v1 → v2 did.
  //
  // NOT MIGRATED, deliberately: `snug_auth_specs` rows are left exactly where they are.
  // P0 is ADDITIVE (fold B1) — v3 keeps shipping alongside v4 until P3 rewires its last
  // consumer, so translating specs into connections here would give one connection two
  // live writers. What v4 DOES clean up on this path is the ORPHANED credential slice:
  // see `wipeLegacyAuthSlice`, which runs on open rather than in the migration because
  // the Q9 self-heal can also produce a first-v4 open (fold T-M4).
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
  // v4 → v5 (TASK-20260810-p3-wizard): DROP `snug_auth_specs`. Fold B1's named exit, and
  // the first DESTRUCTIVE migration in this file — so it is worth saying exactly what is
  // and is not being destroyed.
  //
  // WHAT GOES: the v3 spec table. Its last consumer (the playground's net wiring and the
  // v3 wizard) was rewired to `snug_connections` in P3, so nothing reads these rows any
  // more. Leaving the table would leave a SECOND live grant surface that the executor no
  // longer consults but that still looks authoritative in an exported file — a row saying
  // `approved` for hosts nothing will ever honor. A stale approval a user can still read
  // is worse than no approval: it is a promise the runtime has stopped keeping.
  //
  // WHAT DOES NOT GO: credential VALUES. They live in `snug_secrets` and are untouched
  // here. A user who had connected an app under v3 keeps their key bytes; what they lose
  // is the v3 GRANT, so the app re-enters the wizard and is re-approved into a v4 row.
  // That re-approval is deliberate rather than regrettable — v4 freezes a slot-keyed
  // ceiling that v3's app-keyed row cannot express, and inheriting an approval across
  // that change would mean honoring consent for a shape the user never saw.
  //
  // DROP TABLE IF EXISTS, not a bare DROP: the self-heal guard (Q9) can produce an open
  // where a stamped version never had its tables created, and a migration that threw on a
  // missing table would make that file permanently unopenable.
  (db) => {
    db.run(`DROP TABLE IF EXISTS ${USERDB_TABLES.authSpecs}`);
    for (const ddl of USERDB_DDL) db.run(ddl);
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
  // v5 → v6 (TASK-20260811, ADR-0018): add `snug_app_versions.runtime_contract_json`, the
  // per-version runtime contract a lean app turn assembles FROM.
  //
  // THIS ONE CANNOT BE A BARE REPLAY, and it is the case the v4 comment above predicted:
  // v6 adds a COLUMN to an EXISTING table, and `CREATE TABLE IF NOT EXISTS` does nothing
  // to a table that already exists — so a replay-only migration would leave a v5-shaped
  // `snug_app_versions` under a v6 stamp, and every contract read/write would fail with a
  // raw "no such column" that looks like a code bug. `addColumnIfMissing` is what makes
  // the stamp true, exactly as it did for v1 → v2's four columns.
  //
  // The replay still runs alongside it, for a file that arrives at v6 missing whole tables
  // (the self-heal path can produce one).
  (db) => {
    for (const ddl of USERDB_DDL) db.run(ddl);
    addColumnIfMissing(db, USERDB_TABLES.appVersions, 'runtime_contract_json', 'TEXT');
    for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  },
];

/**
 * The DDL-REPLAY SELF-HEALING GUARD (Q9, absorbed from next-steps `23266fc`).
 *
 * `migrate()` stamps `PRAGMA user_version` UNCONDITIONALLY, so the stamp is a claim
 * about which migrations RAN, never evidence that the tables they were supposed to
 * create actually exist. A file can therefore read as v4 with `snug_connections`
 * missing — from an interrupted write, a partially-restored backup, or a migration that
 * threw after the stamp — and the forward-only loop will run NOTHING, leaving the first
 * accessor call to fail with a raw SQLite "no such table" that looks like a code bug.
 *
 * So the expected table set is verified against `sqlite_master` and, on ANY miss, the
 * idempotent DDL is replayed before the stamp is trusted. This is a targeted CREATE, not
 * a re-seed: `CREATE TABLE IF NOT EXISTS` cannot touch a table that is present, so rows
 * in every surviving table are left exactly as they are.
 *
 * Returns TRUE when it healed, because a heal MUTATES the file and the caller must mark
 * the handle dirty — the same lesson as `migrate()`'s return value (review finding 1: a
 * mutation that never reaches disk leaves the file lying again on the next open).
 */
function healMissingTables(db: Database): boolean {
  const present = new Set(
    selectRows(db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => String(row[0])),
  );
  // The expected set is "tables the DDL replay can actually recreate" — DERIVED from
  // USERDB_DDL, never Object.values(USERDB_TABLES): that map still carries
  // `snug_auth_specs` (dropped at v5, deliberately absent from the DDL), and counting it
  // as a miss would make every open of a healthy post-v5 file report healed=true and
  // persist spuriously. A "miss" the replay cannot fill is not a miss the guard can heal.
  const creatable = USERDB_DDL.map((ddl) => ddl.match(/CREATE TABLE IF NOT EXISTS (\S+)/)?.[1]).filter(
    (name): name is string => name !== undefined,
  );
  // One CREATE per DDL statement is the stated invariant; a statement written in any
  // other shape would silently fall out of the derivation and disable the guard for its
  // table — fail loudly instead (Gate-5 review hardening).
  if (creatable.length !== USERDB_DDL.length) {
    throw new Error(`healMissingTables: ${USERDB_DDL.length - creatable.length} USERDB_DDL statement(s) did not parse as CREATE TABLE IF NOT EXISTS`);
  }
  const missing = creatable.filter((table) => !present.has(table));
  if (missing.length === 0) return false;
  for (const ddl of USERDB_DDL) db.run(ddl);
  for (const ddl of USERDB_INDEX_DDL) db.run(ddl);
  return true;
}

/**
 * The LEGACY-SLICE WIPE (fold T-M4) — run EXACTLY ONCE, on the open that advances a file
 * from v3 to v4, and never again.
 *
 * WHAT IT REMOVES. v3's `authCredentialSecretKey` builds `auth:<appId>:<field>` with NO
 * slot, so under v4's slot-keyed shape those rows hold REAL credential values that
 * nothing in v4 lists, reads, or wipes — the AL-03 lingering-values failure exactly.
 * They are orphaned, not merely stale, and orphaned credentials in a file that SYNCS are
 * the worst kind.
 *
 * WHY ONCE, AND NOT ON EVERY OPEN. This is the trap in an otherwise obvious cleanup.
 * `packages/auth/src/credential-store.ts` is a LIVE writer of exactly these keys and
 * keeps shipping through P0 under the additive cutover rule (fold B1) — it is not dead
 * code yet, it is the v3 path still serving connected apps. A wipe on every open would
 * therefore delete credentials that the still-shipping v3 path wrote moments earlier,
 * turning a one-time cleanup into a recurring self-inflicted disconnection. Gating on
 * "the migration actually advanced this file to v4" makes the wipe a true migration step
 * that a v3-era file passes through once; when P3 retires the v3 writers there will be
 * nothing left for it to find, and it can go.
 *
 * SCOPED BY SEGMENT COUNT (`isLegacyAppSecretKey`), never by prefix: a `LIKE
 * 'auth:<appId>:%'` delete would also take every live v4 `auth:<appId>:<slot>:*` key and
 * disconnect every connected app on the next hub start. Non-auth namespaces (`byok:*`)
 * and the app-agnostic auth keys (`auth:_state_hmac`, `auth:_flow:*`) are outside the
 * rule by construction.
 *
 * Returns the number of rows removed so the caller can mark dirty only when it mattered
 * — a clean file must not be re-persisted on every open.
 */
function wipeLegacyAuthSlice(db: Database): number {
  const keys = selectRows(db, `SELECT key FROM ${USERDB_TABLES.secrets}`)
    .map((row) => String(row[0]))
    .filter(isLegacyAppSecretKey);
  if (keys.length === 0) return 0;
  for (const key of keys) {
    db.run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [key]);
  }
  // Reclaim the pages, per the `deleteApp`/`exportUserDb` precedent: a DELETE only frees
  // the pages, so without this the orphaned credential bytes survive in the file and
  // travel in a secrets-bearing export — the wipe would remove the KEYS while leaving the
  // VALUES exactly where an attacker would look for them. Best-effort for the same reason
  // as every other reclaim here; the rows are unreachable from every query path either way.
  try {
    db.run('VACUUM');
  } catch {
    /* space reclaim is an optimization, not part of the wipe's contract */
  }
  return keys.length;
}

// ------------------------------------------------------- auth-spec reconciliation

/** Module-level row reader (used against the incoming import candidate too). */
function selectRows(target: Database, sql: string, params?: unknown[]): unknown[][] {
  const statement = target.prepare(sql);
  try {
    if (params !== undefined && params.length > 0) statement.bind(params as never);
    const rows: unknown[][] = [];
    while (statement.step()) rows.push(statement.get() as unknown[]);
    return rows;
  } finally {
    statement.free();
  }
}

/** The identity a locally-approved connection is compared against during import. */
interface LocalApprovedConnection {
  requirementJson: string;
  allowedHosts: string;
  approvedAt: string | null;
  requirementVersion: number;
}

const connectionKey = (appId: string, slot: string): string => `${appId}\u0000${slot}`;

/**
 * The DELTA-AWARE import reconciliation for `snug_connections` (fold T-M5), the v4
 * sibling of `reconcileImportedAuthSpecs` and run on the candidate BEFORE it goes live.
 * Per imported row:
 *
 * - BYTE-IDENTICAL `(requirement_json, allowed_hosts)` to a locally-APPROVED row →
 *   status/`approved_at` RESTORED. Identical rows carry zero attack surface, and blanket
 *   demotion would nuke every approval on each routine two-device pull and train exactly
 *   the approval fatigue that makes users click through the review that protects them.
 * - Anything else that validates → demoted to `declared`, `approved_at` cleared,
 *   `imported = 1`, and `allowed_hosts` REWRITTEN from the requirement. A doctored,
 *   widened host column is therefore never honored — the union is recomputed, never
 *   trusted, which is the property that makes the byte-identity test above safe to have.
 * - A REVOKED row stays revoked with its tombstone intact. It can never be promoted by
 *   an import: the whole point of keeping the row is that the user's revocation outlives
 *   a file swap.
 * - Structurally unusable → dropped and surfaced in the import report.
 *
 * `pending_requirement_json` is CLEARED on every demoted row (skew-window safety, fold
 * S-m2): the executor binds to the approved requirement, and a staged edit that survived
 * an import into a row the user has not re-approved would be a requirement nobody
 * reviewed sitting in the seat the next `reapproveConnection` promotes.
 *
 * HOST-UNION OUTPUT STABILITY IS LOAD-BEARING here, not cosmetic. Branch 1 compares the
 * STORED `allowed_hosts` JSON against the local row's, so if `deriveConnectionAllowedHosts`
 * ever emitted different bytes for an unchanged requirement (a different sort, different
 * normalization, different spacing) every approved row would miss branch 1 and mass-demote
 * on the first sync pull — which reads to the user as "the update logged me out of
 * everything". Both sides of that comparison are produced by the same function, and the
 * approval path stores exactly what it derives.
 */
/**
 * IMPORTED CONTRACTS ARE UNTRUSTED (ADR-0018 D2(iii), AC-F1-7, fold F-SB1).
 *
 * A runtime contract is rendered into the SYSTEM slot of every turn the app takes, so an
 * imported one is an untrusted file asking to speak with system authority — the same shape
 * of claim `reconcileImportedConnections` refuses for grants, and refused the same way:
 * keep it ONLY when its canonical bytes match a contract this hub already knows.
 *
 * Comparison is CANONICAL, not raw: an identical contract re-serialized with different key
 * order must still match, or every legitimate sync/backup round trip would silently strip
 * contracts and degrade every app to generic layers.
 *
 * The local set is keyed by bytes alone, deliberately — not by (app, version). A contract
 * the user has already reviewed on one version is the same reviewed artifact arriving on
 * another, and pinning to the version number would drop legitimate rows after any local
 * edit shifted the numbering.
 */
function reconcileImportedRuntimeContracts(
  next: Database,
  localContractBytes: ReadonlySet<string>,
): UserDbImportReport['droppedRuntimeContracts'] {
  const dropped: UserDbImportReport['droppedRuntimeContracts'] = [];
  const rows = selectRows(
    next,
    `SELECT app_id, version, runtime_contract_json FROM ${USERDB_TABLES.appVersions}
     WHERE runtime_contract_json IS NOT NULL`,
  );
  for (const row of rows) {
    const appId = String(row[0]);
    const version = Number(row[1]);
    const parsed = parseRuntimeContract(String(row[2]));
    // An unparseable/over-bound imported contract is dropped for the same reason a
    // non-matching one is: it cannot be shown to have been reviewed here.
    if (parsed !== undefined && localContractBytes.has(canonicalRuntimeContract(parsed))) continue;
    dropped.push({ appId, version });
    next.run(
      `UPDATE ${USERDB_TABLES.appVersions} SET runtime_contract_json = NULL WHERE app_id = ? AND version = ?`,
      [appId, version],
    );
  }
  return dropped;
}

function reconcileImportedConnections(
  next: Database,
  localApproved: ReadonlyMap<string, LocalApprovedConnection>,
): UserDbImportReport['droppedConnections'] {
  const dropped: UserDbImportReport['droppedConnections'] = [];
  const rows = selectRows(
    next,
    `SELECT app_id, slot, requirement_json, allowed_hosts, status FROM ${USERDB_CONNECTIONS_TABLE}`,
  );
  for (const row of rows) {
    const appId = String(row[0]);
    const slot = String(row[1]);
    const requirementJson = String(row[2]);
    const allowedHostsJson = String(row[3]);
    const status = String(row[4]);
    const drop = (reason: string): void => {
      dropped.push({ appId, slot, reason });
      next.run(`DELETE FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ? AND slot = ?`, [appId, slot]);
    };

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requirementJson);
    } catch {
      drop('requirement_json is not valid JSON');
      continue;
    }

    const validated = connectionRequirementSchema.safeParse(parsedJson);
    if (!validated.success) {
      // No unknown-keys-only escape hatch here, unlike v3's R2 preserve rule: the
      // requirement schema is strict at every level BY DESIGN (a future seat must not
      // ride in unreviewed on a channel that predates it), so "preserve the bytes,
      // demote the trust" would mean storing a row no v4 accessor can re-validate or
      // approve. Dropping it and reporting the reason is the honest outcome.
      drop(validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; '));
      continue;
    }

    if (status === CONNECTION_STATUS.revoked) {
      // A tombstone survives the import unchanged. Deliberately BEFORE the byte-identity
      // branch: a revoked row is never a candidate for restoring an approval.
      continue;
    }

    const local = localApproved.get(connectionKey(appId, slot));
    if (local !== undefined && local.requirementJson === requirementJson && local.allowedHosts === allowedHostsJson) {
      next.run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET status = ?, approved_at = ?, requirement_version = ?, pending_requirement_json = NULL
         WHERE app_id = ? AND slot = ?`,
        [CONNECTION_STATUS.approved, local.approvedAt, local.requirementVersion, appId, slot],
      );
      continue;
    }

    next.run(
      `UPDATE ${USERDB_CONNECTIONS_TABLE}
       SET status = ?, approved_at = NULL, allowed_hosts = ?, imported = 1, pending_requirement_json = NULL
       WHERE app_id = ? AND slot = ?`,
      [
        CONNECTION_STATUS.declared,
        JSON.stringify(deriveConnectionAllowedHosts(validated.data)),
        appId,
        slot,
      ],
    );
  }
  return dropped;
}

/**
 * Forward-migrate to the current schema version.
 *
 * Reports the version it FOUND, not just whether it advanced, because two callers need
 * to know which boundaries were crossed rather than merely that something happened:
 * `advanced` still drives the mark-dirty rule (review finding 1: opening an existing v2
 * file and closing without any other write used to lose the migration on disk — the
 * persisted version lied until an unrelated write happened to flush it), while the
 * legacy-slice wipe fires only when `found < 4`, so a file already at v4 never has its
 * live credentials re-examined (see `wipeLegacyAuthSlice`).
 */
function migrate(db: Database): { found: number; advanced: boolean } {
  const found = readUserVersion(db);
  for (let v = found; v < USERDB_SCHEMA_VERSION; v++) {
    MIGRATIONS[v]?.(db);
  }
  db.run(`PRAGMA user_version = ${USERDB_SCHEMA_VERSION}`);
  return { found, advanced: found < USERDB_SCHEMA_VERSION };
}

interface LifecycleTarget {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  visibilityState?: string;
}

export async function openUserDb(options: OpenUserDbOptions = {}): Promise<OpenUserDbResult> {
  // Default backend lives in the user DB's OWN directory (F13) — never the per-app store.
  const backend = options.backend ?? detectPersistenceBackend(USERDB_OPFS_DIR);
  const file = options.file ?? USERDB_FILE;
  const SQL = await initSqlJs(sqlJsInitConfig(options));

  // ADOPT-FORWARD (ADR-0042, AC1/AC2/AC22). The canonical name moved from
  // `user.sqlite` to `user.snug`; a user upgrading has bytes only under the old name.
  // Reading the legacy file when the canonical one is absent is the ONLY thing
  // standing between them and a pristine empty database opening over real data —
  // which throws nothing, logs nothing, and shows them an empty hub.
  //
  // Both reads go through `backend.load`, deliberately. It is the only slot-aware
  // reader: on OPFS the bytes never live under a bare filename but in `<file>.slot-a`
  // / `.slot-b` behind a `.ptr`, so a "cheap existence probe" on the raw name is
  // silently wrong on the web path, where every existing user is.
  //
  // Adoption is READ-ONLY: nothing renames, copies or deletes the legacy file here.
  // The next ordinary persist writes the canonical name, and the old file stays put
  // as the user's own backup. Once the canonical file exists it always wins, so a
  // stale legacy copy can never roll a user back.
  const loaded = (await backend.load(file)) ?? (file === USERDB_FILE ? await backend.load(USERDB_LEGACY_FILE) : undefined);

  // A protected file (ADR-0043) is unwrapped HERE, before every existing guard, so
  // everything downstream — the magic check, the open-check, the quarantine path, the
  // version gate — sees ordinary SQLite bytes and behaves exactly as it always has.
  // The alternative (teaching each guard about ciphertext) would have spread the
  // format across five call sites and made 'locked' reachable from four of them.
  let stored = loaded;
  let sealer: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
  /** Used only by the corrupt branch's `openFresh` — see its comment. */
  let freshSealer: ((bytes: Uint8Array) => Promise<Uint8Array>) | undefined;
  if (loaded !== undefined && isEncryptedContainer(loaded)) {
    const opened = await decryptContainer(loaded, options.secrets ?? {});
    if (opened.status === 'locked') {
      // Healthy file, no key. Nothing is touched — see the `locked` doc comment.
      return { status: 'locked', message: 'this Snug file is protected — enter your passphrase or Recovery Key' };
    }
    if (opened.status === 'corrupt') {
      // Damage, and we can say so specifically instead of blaming the user's memory.
      stored = loaded; // fall through to the existing quarantine path with the raw bytes
      // The bytes WERE a container, so a "start fresh" here must not silently drop the
      // user's protection (D-3). We cannot reuse the damaged file's key, so mint a new
      // container from the secrets they just supplied — same passphrase, same recovery
      // key, new salt and slots. Only possible when both were given.
      const secrets = options.secrets;
      if (secrets?.passphrase !== undefined && secrets.recoveryKey !== undefined) {
        freshSealer = (next: Uint8Array) =>
          encryptContainer(next, { passphrase: secrets.passphrase!, recoveryKey: secrets.recoveryKey! });
      }
    } else {
      stored = opened.bytes;
      // Unwrap the file key ONCE, here, and close over it. Every later write re-seals
      // into this same container: same header, same slots (so the Recovery Key keeps
      // working even in a passphrase-only session), fresh payload IV. Deriving the key
      // again on each save would also cost 175 ms of PBKDF2 per keystroke-burst.
      const keyed = await openFileKey(loaded, options.secrets ?? {});
      if (keyed.status === 'ok') {
        const original = loaded;
        const fileKey = keyed.fileKey;
        sealer = (next: Uint8Array) => resealContainer(original, fileKey, next);
      }
    }
  }

  if (stored !== undefined) {
    let candidate: Database | undefined;
    try {
      // sql.js silently treats empty/zeroed bytes as a fresh database — but for the
      // USER DB that means an interrupted write would silently erase everything.
      // Magic-less stored bytes are corruption, full stop (F6).
      if (!hasSqliteMagic(stored)) throw new Error('missing SQLite header (empty or truncated file)');
      candidate = new SQL.Database(stored);
      candidate.exec('SELECT count(*) FROM sqlite_master'); // open-check: corrupt bytes fail here
    } catch (err) {
      candidate?.close();
      // F6: the user DB never fails open — quarantine and make recovery an explicit
      // choice. Unique name per occurrence: repeat corruption must not overwrite the
      // previous forensic copy (umbrella review minor 6).
      const quarantinedFile = `${file}.corrupt-${Date.now().toString(36)}.bak`;
      await backend.save(quarantinedFile, stored);
      return {
        status: 'corrupt',
        quarantinedFile,
        message: `user DB bytes were unreadable and were quarantined to "${quarantinedFile}": ${errorMessage(err)}`,
        /**
         * A fresh database over a quarantined one — and it must be born PROTECTED when
         * the file it replaces was (diff review D-3). Otherwise: a protected file's
         * payload is damaged, the user picks "start fresh", and the empty database's
         * first flush overwrites `user.snug` with an UNENCRYPTED file while they still
         * believe they are protected. The `.bak` keeps the ciphertext, so it is
         * recoverable — but they would be writing plaintext and never know.
         *
         * `freshSealer` is non-undefined only when the damaged bytes were a container
         * AND a supplied secret opened its slots (see the open path above), so a
         * genuinely corrupt non-container quarantine still starts plaintext.
         */
        openFresh: () => Promise.resolve(construct(SQL, new SQL.Database(), backend, file, options, freshSealer)),
      };
    }
    const foundVersion = readUserVersion(candidate);
    if (foundVersion > USERDB_SCHEMA_VERSION) {
      candidate.close();
      return {
        status: 'unsupported',
        foundVersion,
        message: `user DB is schema v${foundVersion}; this hub supports up to v${USERDB_SCHEMA_VERSION} — upgrade the hub, do not overwrite the file`,
      };
    }
    return { status: 'ok', userDb: construct(SQL, candidate, backend, file, options, sealer) };
  }

  return { status: 'ok', userDb: construct(SQL, new SQL.Database(), backend, file, options) };
}

function construct(
  SQL: SqlJsStatic,
  initial: Database,
  backend: PersistenceBackend,
  file: string,
  options: OpenUserDbOptions,
  /**
   * Present when this file is protected: re-seals every write-back.
   *
   * It is a CLOSURE over the container that was opened, not a bag of secrets, and that
   * distinction is load-bearing. A session that unlocked with the passphrase alone does
   * not hold the Recovery Key and never can — so rebuilding the container from secrets
   * on each save would silently drop the recovery slot and strand the user the first
   * time they forgot their passphrase. Re-sealing instead REUSES the existing slots and
   * their wrapped file key, replacing only the payload.
   *
   * If this were ever dropped, the next save would rewrite a protected file as
   * plaintext while its owner believed it protected — so it is threaded explicitly.
   */
  initialSealer?: (bytes: Uint8Array) => Promise<Uint8Array>,
): UserDb {
  // Mutable: `protect()` installs or removes it when the user turns protection on/off.
  let sealer = initialSealer;
  let db = initial;
  const debounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  const maxBytes = options.maxBytes ?? USERDB_LIMITS.MAX_USERDB_BYTES;
  const retained = options.versionsRetained ?? USERDB_LIMITS.VERSIONS_RETAINED;
  const admissionGate = options.admissionGate ?? defaultAdmissionGate;
  let closed = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> = Promise.resolve();

  const migration = migrate(db);
  // Q9 self-heal, AFTER the migration and BEFORE anything trusts the schema: the
  // `user_version` stamp is unconditional, so a file can read as current with tables
  // missing. Verifying against sqlite_master is the only thing that makes the stamp
  // meaningful (see `healMissingTables`).
  const healed = healMissingTables(db);
  // The legacy-slice wipe is a MIGRATION STEP, gated on this open having actually
  // crossed v3 → v4 (fold T-M4). It deliberately does NOT run for a file already at v4:
  // the v3 credential writers are still shipping under the additive cutover rule, so a
  // wipe on every open would delete live credentials they had just written.
  const wiped = migration.found < USERDB_SCHEMA_VERSION ? wipeLegacyAuthSlice(db) : 0;
  seedMeta();
  // A migration, a heal, or a wipe each MUTATED the file: make it durable even if this
  // session never writes again (markDirty is hoisted; fresh files are marked dirty by
  // seedMeta's write anyway, and an untouched current-version file stays clean — no
  // spurious no-op saves).
  if (migration.advanced || healed || wiped > 0) markDirty();

  // ------------------------------------------------------------- write-back pipeline

  function persist(): Promise<void> {
    const run = saving.then(async () => {
      if (!dirty || closed) return;
      dirty = false;
      const bytes = db.export();
      try {
        // Re-seal on the way out when this file is protected. A fresh IV per write
        // (never a counter, never derived) — the A/B slot scheme can put one logical
        // save into two slots, and a repeated GCM nonce leaks plaintext AND forges the
        // auth key. Sealing here, at the single write-back, is what keeps every
        // backend (OPFS, IndexedDB, desktop file) protected without any of them
        // knowing the format exists.
        //
        // NOTE THE ORDER. `db.export()` happens BEFORE this await, so the bytes are a
        // snapshot taken while `dirty` was cleared. Any mutation arriving during the
        // seal re-marks the db dirty, and because that flag is checked again on the
        // next turn of the `saving` chain, the newer state is written by the following
        // persist rather than lost. Encryption is what made this window observable:
        // it is the first thing to put real async work between snapshot and save.
        const payload = sealer === undefined ? bytes : await sealer(bytes);
        await backend.save(file, payload);
      } catch {
        dirty = true; // persistence failure must not take down the service; retried on next flush/mutation
      }
    });
    saving = run.catch(() => undefined);
    return run;
  }

  function markDirty(): void {
    dirty = true;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void persist();
    }, debounceMs);
  }

  async function persistNow(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await persist();
  }

  const onPageHide = (): void => {
    void persistNow();
  };
  const onVisibilityChange = (): void => {
    if ((globalThis as { document?: LifecycleTarget }).document?.visibilityState === 'hidden') void persistNow();
  };
  const lifecycleWindow = (globalThis as { window?: LifecycleTarget }).window;
  const lifecycleDocument = (globalThis as { document?: LifecycleTarget }).document;
  lifecycleWindow?.addEventListener?.('pagehide', onPageHide);
  lifecycleDocument?.addEventListener?.('visibilitychange', onVisibilityChange);

  // --------------------------------------------------------------------- sql helpers

  function assertOpen(): void {
    if (closed) throw new UserDbError(USERDB_ERROR_CODES.CLOSED, 'user DB is closed');
  }

  function run(sql: string, params?: unknown[]): void {
    db.run(sql, (params ?? []) as never);
    markDirty();
  }

  function selectFrom(target: Database, sql: string, params?: unknown[]): unknown[][] {
    const statement = target.prepare(sql);
    try {
      if (params !== undefined && params.length > 0) statement.bind(params as never);
      const rows: unknown[][] = [];
      while (statement.step()) rows.push(statement.get() as unknown[]);
      return rows;
    } finally {
      statement.free();
    }
  }

  function select(sql: string, params?: unknown[]): unknown[][] {
    return selectFrom(db, sql, params);
  }

  function now(): string {
    return new Date().toISOString();
  }

  function seedMeta(): void {
    const seeded = select(`SELECT value FROM ${USERDB_TABLES.meta} WHERE key = 'db_id'`);
    if (seeded.length === 0) {
      run(`INSERT INTO ${USERDB_TABLES.meta} (key, value) VALUES ('db_id', ?), ('created_at', ?)`, [
        crypto.randomUUID(),
        now(),
      ]);
    }
  }

  /** Approximate current size without a full export: page_count × page_size. */
  function currentBytes(): number {
    const pages = select('PRAGMA page_count')[0]?.[0];
    const pageSize = select('PRAGMA page_size')[0]?.[0];
    return (typeof pages === 'number' ? pages : 0) * (typeof pageSize === 'number' ? pageSize : 0);
  }

  function guardAddedBytes(added: number, what: string): void {
    if (currentBytes() + added > maxBytes) {
      throw new UserDbError(
        USERDB_ERROR_CODES.TOO_LARGE,
        `${what} would push the user DB past the ${maxBytes}-byte cap`,
      );
    }
  }

  // ------------------------------------------------- kv tables (settings/profile/…)

  function kvGet(table: string, key: string): unknown {
    assertOpen();
    const rows = select(`SELECT value FROM ${table} WHERE key = ?`, [key]);
    const raw = rows[0]?.[0];
    return raw === undefined ? undefined : (JSON.parse(String(raw)) as unknown);
  }

  function kvSet(table: string, key: string, value: unknown): void {
    assertOpen();
    guardAddedBytes(JSON.stringify(value ?? null).length + key.length, `setting "${key}"`);
    run(`INSERT OR REPLACE INTO ${table} (key, value) VALUES (?, ?)`, [key, JSON.stringify(value ?? null)]);
  }

  // ------------------------------------------ connection helpers (Dynamic Auth v2)

  /**
   * Strict ingest at the write boundary, fail closed — the v4 sibling of
   * `parseAuthSpecStrict`. Every accessor parses BEFORE touching a row, so a rejected
   * requirement leaves the database byte-identical: there is no partial write to undo.
   */
  function parseConnectionRequirementStrict(requirement: unknown): ConnectionRequirement {
    const parsed = connectionRequirementSchema.safeParse(requirement);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new UserDbError(
        USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT,
        `connection requirement failed validation: ${issues}`,
      );
    }
    return parsed.data;
  }

  /**
   * Parse strictly AND require the requirement's own `slot` to match the slot it is being
   * written to (review MINOR).
   *
   * The two checks are fused into one helper so no accessor can accidentally do the first
   * without the second — the split identity is only reachable by forgetting this call,
   * and three accessors need it (`putDeclaredConnection`, `stagePendingRequirement`, and
   * `reapproveConnection`, which promotes a pending row storage may have forged).
   */
  function parseConnectionRequirementForSlot(requirement: unknown, appId: string, slot: string): ConnectionRequirement {
    const validated = parseConnectionRequirementStrict(requirement);
    if (validated.slot !== slot) {
      throw new ConnectionSlotMismatch(appId, slot, validated.slot);
    }
    return validated;
  }

  /**
   * Run channel ADMISSION, then validate (review MAJOR-2).
   *
   * ORDER IS LOAD-BEARING and runs admission FIRST: on a registry-borrow hit the gate
   * SUBSTITUTES the registry's pinned hosts for the declared ones, and it is the
   * substituted value that must be validated, hashed, host-derived and persisted.
   * Validating first and admitting after would store the attacker's `evil.example`
   * unless every caller remembered to re-derive — exactly the "guard beside the path
   * rather than on it" shape this fix exists to remove.
   *
   * The slot check runs on the POST-substitution requirement for the same reason.
   */
  function admitAndParse(
    requirement: unknown,
    appId: string,
    slot: string,
    channel: string,
  ): ConnectionRequirement {
    const admitted = admissionGate(requirement, { channel, appId, slot });
    if (!admitted.ok) {
      throw new ConnectionNotAdmitted(appId, slot, channel, admitted.issues);
    }
    return parseConnectionRequirementForSlot(admitted.requirement, appId, slot);
  }

  const CONNECTION_COLUMNS =
    'app_id, slot, requirement_json, requirement_version, provenance, confidence, status, pending_requirement_json, imported, allowed_hosts, approved_at, revoked_at, created_at, updated_at';

  const toConnectionRow = (row: unknown[]): ConnectionRow => ({
    appId: String(row[0]),
    slot: String(row[1]),
    // JSON.parse, not zod: every write validates, so re-parsing here would spend a
    // schema pass per read to re-prove a boundary invariant — and would make a row
    // written by a NEWER hub unreadable rather than merely unapprovable.
    requirement: JSON.parse(String(row[2])) as ConnectionRequirement,
    requirementVersion: Number(row[3]),
    provenance: String(row[4]) as ConnectionProvenance,
    ...(row[5] !== null && row[5] !== undefined ? { confidence: Number(row[5]) } : {}),
    status: String(row[6]) as ConnectionStatus,
    ...(row[7] !== null && row[7] !== undefined
      ? { pendingRequirement: JSON.parse(String(row[7])) as ConnectionRequirement }
      : {}),
    imported: row[8] === 1,
    allowedHosts: JSON.parse(String(row[9])) as string[],
    ...(row[10] !== null && row[10] !== undefined ? { approvedAt: String(row[10]) } : {}),
    ...(row[11] !== null && row[11] !== undefined ? { revokedAt: String(row[11]) } : {}),
    createdAt: String(row[12]),
    updatedAt: String(row[13]),
  });

  function readConnectionRow(appId: string, slot: string): ConnectionRow | undefined {
    const row = select(
      `SELECT ${CONNECTION_COLUMNS} FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ? AND slot = ?`,
      [appId, slot],
    )[0];
    return row === undefined ? undefined : toConnectionRow(row);
  }

  /** Read a row or throw NOT_FOUND — the shared preamble of every non-creating accessor. */
  function requireConnectionRow(appId: string, slot: string): ConnectionRow {
    const existing = readConnectionRow(appId, slot);
    if (existing === undefined) {
      throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `no connection "${appId}/${slot}"`);
    }
    return existing;
  }

  /**
   * Delete the credential slice for ONE slot (`auth:<appId>:<slot>:*`).
   *
   * Slot-scoped, and the scoping is the point: an app-wide `auth:<appId>:%` delete would
   * take a SIBLING slot's live credentials, so revoking Dropbox in a three-cloud app
   * would silently disconnect OneDrive too (R6's whole motivating shape).
   *
   * LIKE metacharacters in the prefix are escaped exactly as `deleteApp` does — the same
   * known limit applies (an appId or slot containing a literal colon could over-match),
   * and it is unreachable here for a second reason beyond randomUUID app ids:
   * `CONNECTION_SLOT_RULE` admits no colon.
   */
  function wipeConnectionSecrets(appId: string, slot: string): void {
    const prefix = authConnectionSlotPrefix(appId, slot).replace(/([!%_])/g, '!$1');
    run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key LIKE ? ESCAPE '!'`, [`${prefix}%`]);
    // RECLAIM THE PAGES, exactly as `deleteApp` does and for exactly the same reason:
    // a DELETE only marks the row's pages FREE, so the credential bytes stay in the file
    // and travel in `exportUserDb({ includeSecrets: true })` — a revoked API secret
    // readable in a synced image is the AL-03 lingering-values failure with extra steps.
    // Mutation-evidenced: the byte-probe in the AC13 test fails without this line while
    // every API-level assertion still passes, which is precisely how this class of bug
    // ships unnoticed.
    //
    // Best-effort for the same reason as `deleteApp`: VACUUM allocates a second copy of
    // the database, so it is the statement most likely to fail under memory pressure. A
    // failed reclaim must not fail an already-committed revocation — the row is gone from
    // every query path regardless, and the freed pages get reused later.
    try {
      db.run('VACUUM');
    } catch {
      /* space reclaim is an optimization, not part of the revoke's contract */
    }
  }

  /**
   * Delete the harvested sidecar identity directory once NO approved connection's frozen
   * ceiling carries the sidecar symbolic host (TASK-20260820-host-pseudonymisation,
   * owner decision 2026-08-20). The directory is a persisted third-party-PII asset —
   * contact names and jids harvested for the R-9 egress scrub — and must not outlive the
   * last connection that justified holding it. Called from the two EXPLICIT-WITHDRAWAL
   * seams: `revokeConnection` (tombstone; status leaves `approved`) and `deleteApp`
   * (cascade removes the rows). Import reconciliation ALSO demotes approved rows — to
   * `declared` — and deliberately does NOT wipe: the app data the directory scrubs
   * against rides the same import, so wiping there would strip the scrub exactly where
   * the replay risk travels (Gate-5 review, cross-file finding 1). `target` lets
   * deleteApp run the check INSIDE its transaction, so the wipe commits or rolls back
   * with the very rows it reasons about.
   */
  function wipeSidecarIdentityDirectoryIfOrphaned(target: Database = db): void {
    const rows = selectFrom(target, `SELECT allowed_hosts FROM ${USERDB_CONNECTIONS_TABLE} WHERE status = ?`, [
      CONNECTION_STATUS.approved,
    ]);
    const stillHeld = rows.some((row) => {
      try {
        const hosts = JSON.parse(String(row[0])) as unknown;
        return Array.isArray(hosts) && hosts.includes(SIDECAR_SYMBOLIC_HOST);
      } catch {
        // A malformed ceiling grants nothing — treating it as "still held" would let a
        // corrupted row pin third-party PII forever.
        return false;
      }
    });
    if (!stillHeld) {
      target.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [
        SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY,
      ] as never);
      // The raw `target.run` bypasses the dirty-tracking `run()` wrapper (a transaction
      // handle must be usable here), so durability is THIS function's job, not each
      // caller's — a wipe that lands only in the in-memory image resurrects third-party
      // PII on the next open (Gate-5 review). Idempotent and debounced, so the extra
      // call inside deleteApp's transaction costs nothing.
      markDirty();
    }
  }

  /**
   * `requirement_version` for a persisted replacement (fold T-mn3): the SAME number when
   * the canonical hash matches, one higher when it differs.
   *
   * Canonical rather than literal comparison because the channels that produce
   * requirements do not emit stable key order — an LLM re-emits the same requirement
   * with keys shuffled every turn, and a `JSON.stringify` comparison would bump the
   * version on every rebuild. That is not merely noisy: P2's edit pipeline uses an
   * unchanged version as its "nothing to re-review" signal, so phantom bumps would
   * manufacture re-approval prompts for edits that changed nothing.
   */
  function nextRequirementVersion(previous: ConnectionRequirement, next: ConnectionRequirement, current: number): number {
    return canonicalRequirementHash(previous) === canonicalRequirementHash(next) ? current : current + 1;
  }

  // ------------------------------------- driver face: materializer PersistenceBackend
  //
  // The per-app driver computes file names via namespaceToFileName; the wrapper below
  // records the namespace → token mapping BEFORE delegating so load/save can key rest
  // tables. Composing createDbDriver over this backend inherits every exec/kv/export/
  // import guardrail from the tested driver.

  interface NamespaceInfo {
    namespace: string;
    token: string;
  }

  const namespaceByFile = new Map<string, NamespaceInfo>();
  /** F6 sync-hash stability: identical runtime bytes → write-back is a no-op. */
  const lastSavedHash = new Map<string, string>();

  function noteNamespace(namespace: string): string {
    const blobFile = namespaceToFileName(namespace);
    if (!namespaceByFile.has(blobFile)) {
      namespaceByFile.set(blobFile, { namespace, token: appDataToken(namespace) });
    }
    return blobFile;
  }

  function bytesHash(bytes: Uint8Array): string {
    let hash = 5381;
    for (let i = 0; i < bytes.length; i++) {
      hash = ((hash << 5) + hash + bytes[i]!) | 0;
    }
    return `${bytes.length}:${(hash >>> 0).toString(16)}`;
  }

  function restTablesFor(token: string): string[] {
    return select(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ?`, [
      `app_${token}__*`,
    ]).map((row) => String(row[0]));
  }

  function readSchemaJson(token: string): AppSchemaJson | undefined {
    const raw = select(`SELECT schema_json FROM ${USERDB_TABLES.appSchemas} WHERE token = ?`, [token])[0]?.[0];
    return raw === undefined ? undefined : (JSON.parse(String(raw)) as AppSchemaJson);
  }

  /** Copy all rows between same-shaped tables in two databases (non-generated columns only). */
  function copyRows(from: Database, fromTable: string, to: Database, toTable: string): void {
    const columns = selectFrom(from, `PRAGMA table_xinfo(${quoteIdent(fromTable)})`)
      .filter((row) => Number(row[6]) === 0)
      .map((row) => String(row[1]));
    if (columns.length === 0) return;
    const columnList = columns.map(quoteIdent).join(', ');
    const read = from.prepare(`SELECT ${columnList} FROM ${quoteIdent(fromTable)}`);
    const write = to.prepare(
      `INSERT INTO ${quoteIdent(toTable)} (${columnList}) VALUES (${columns.map(() => '?').join(', ')})`,
    );
    try {
      while (read.step()) {
        write.run(read.get() as never);
      }
    } finally {
      read.free();
      write.free();
    }
  }

  function hasTable(target: Database, name: string): boolean {
    return (
      selectFrom(target, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).length > 0
    );
  }

  /** Build the app's runtime database (natural names) from rest tables + registry. */
  function materializeBytes(info: NamespaceInfo): Uint8Array | undefined {
    const schema = readSchemaJson(info.token);
    const restTables = restTablesFor(info.token);
    if (schema === undefined && restTables.length === 0) return undefined;
    const kvRest = appRestTableName(info.token, APP_KV_TABLE);
    const temp = new SQL.Database();
    try {
      const tableNames: string[] = [];
      if (restTables.includes(kvRest)) {
        temp.run(KV_TABLE_DDL);
        tableNames.push(APP_KV_TABLE);
      }
      for (const object of schema?.objects ?? []) {
        temp.run(object.ddl);
        if (object.type === 'table') tableNames.push(object.name);
      }
      for (const name of tableNames) {
        const rest = appRestTableName(info.token, name);
        if (restTables.includes(rest)) copyRows(db, rest, temp, name);
      }
      // AUTOINCREMENT continuity: exact counters from the registry beat max(id)
      // inference (deleted-max rows must never free their ids). sqlite_sequence has
      // NO unique constraint on name, so INSERT OR REPLACE would APPEND a duplicate
      // row and SQLite would read the lower one — UPDATE first, INSERT only when the
      // row does not exist yet (review B1).
      if (schema?.sequences !== undefined && hasTable(temp, 'sqlite_sequence')) {
        for (const [name, seq] of Object.entries(schema.sequences)) {
          temp.run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [seq, name]);
          if (temp.getRowsModified() === 0) {
            temp.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [name, seq]);
          }
        }
      }
      const bytes = temp.export();
      lastSavedHash.set(namespaceToFileName(info.namespace), bytesHash(bytes));
      return bytes;
    } finally {
      temp.close();
    }
  }

  /** Validate + snapshot the runtime's sqlite_master. Throws INVALID_NAME on gate failure. */
  function readRuntimeObjects(temp: Database): { objects: AppSchemaObject[]; tables: string[]; hasKv: boolean } {
    const rows = selectFrom(temp, `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid`);
    const objects: AppSchemaObject[] = [];
    const tables: string[] = [];
    let hasKv = false;
    for (const row of rows) {
      const type = String(row[0]);
      const name = String(row[1]);
      const ddl = String(row[2]);
      if (name.toLowerCase().startsWith('sqlite_')) continue; // engine-internal (sqlite_sequence …)
      if (name === APP_KV_TABLE) {
        hasKv = true;
        tables.push(name);
        continue; // driver-internal — persisted but never registered
      }
      if (!isValidAppObjectName(name)) {
        throw new UserDbError(
          USERDB_ERROR_CODES.INVALID_NAME,
          `app object name ${JSON.stringify(name)} violates the naming rule — write-back refused, previous data retained`,
        );
      }
      if (type !== 'table' && type !== 'index' && type !== 'trigger' && type !== 'view') continue;
      if (type === 'table' && /^CREATE\s+VIRTUAL\s+TABLE/i.test(ddl.trim())) {
        throw new UserDbError(
          USERDB_ERROR_CODES.INVALID_NAME,
          `virtual tables are not portable — "${name}" cannot be persisted`,
        );
      }
      objects.push({ type, name, ddl });
      if (type === 'table') tables.push(name);
    }
    return { objects, tables, hasKv };
  }

  /**
   * Transactional write-back of one app runtime into rest tables + registry. Entirely
   * synchronous on the shared handle: outer persist/export can never observe a torn
   * state. Throws (after ROLLBACK) on gate or cap violations — previous state retained.
   */
  function writeBack(info: NamespaceInfo, temp: Database): void {
    const { objects, tables, hasKv } = readRuntimeObjects(temp);
    db.run('BEGIN IMMEDIATE');
    try {
      for (const rest of restTablesFor(info.token)) {
        db.run(`DROP TABLE IF EXISTS ${quoteIdent(rest)}`);
      }
      db.run('PRAGMA legacy_alter_table = ON');
      for (const name of tables) {
        const ddl = name === APP_KV_TABLE ? KV_TABLE_DDL : objects.find((o) => o.type === 'table' && o.name === name)!.ddl;
        db.run(ddl);
        db.run(`ALTER TABLE ${quoteIdent(name)} RENAME TO ${quoteIdent(appRestTableName(info.token, name))}`);
      }
      db.run('PRAGMA legacy_alter_table = OFF');
      for (const name of tables) {
        copyRows(temp, name, db, appRestTableName(info.token, name));
      }
      if (objects.length > 0) {
        const schemaJson: AppSchemaJson = { objects };
        if (hasTable(temp, 'sqlite_sequence')) {
          const sequences: Record<string, number> = {};
          for (const row of selectFrom(temp, 'SELECT name, seq FROM sqlite_sequence')) {
            if (tables.includes(String(row[0]))) sequences[String(row[0])] = Number(row[1]);
          }
          if (Object.keys(sequences).length > 0) schemaJson.sequences = sequences;
        }
        db.run(
          `INSERT OR REPLACE INTO ${USERDB_TABLES.appSchemas} (app_id, token, schema_json, updated_at) VALUES (?, ?, ?, ?)`,
          [info.namespace, info.token, JSON.stringify(schemaJson), now()],
        );
      } else {
        db.run(`DELETE FROM ${USERDB_TABLES.appSchemas} WHERE token = ?`, [info.token]);
      }
      if (tables.length > 0) {
        db.run(`UPDATE ${USERDB_TABLES.apps} SET uses_db = 1 WHERE app_id = ? AND uses_db = 0`, [info.namespace]);
      }
      if (currentBytes() > maxBytes) {
        throw new UserDbError(
          USERDB_ERROR_CODES.TOO_LARGE,
          `app data for "${info.namespace}" would push the user DB past the ${maxBytes}-byte cap`,
        );
      }
      db.run('COMMIT');
    } catch (err) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      try {
        db.run('PRAGMA legacy_alter_table = OFF');
      } catch {
        /* pragma restore is best-effort */
      }
      throw err;
    }
    markDirty();
  }

  const materializerBackend: PersistenceBackend = {
    kind: backend.kind,
    load: (blobFile) => {
      const info = namespaceByFile.get(blobFile);
      if (info === undefined) return Promise.resolve(undefined);
      return Promise.resolve(materializeBytes(info));
    },
    save: (blobFile, bytes) => {
      const info = namespaceByFile.get(blobFile);
      if (info === undefined) return Promise.resolve();
      const hash = bytesHash(bytes);
      if (lastSavedHash.get(blobFile) === hash) return Promise.resolve();
      let temp: Database | undefined;
      try {
        temp = new SQL.Database(bytes);
        writeBack(info, temp);
        lastSavedHash.set(blobFile, hash);
      } catch (err) {
        options.onAppPersistError?.({
          namespace: info.namespace,
          code: err instanceof UserDbError ? err.code : 'USERDB_PERSIST_FAILED',
          message: errorMessage(err),
        });
        throw err; // the driver keeps the namespace dirty; previous rest state is retained
      } finally {
        temp?.close();
      }
      return Promise.resolve();
    },
  };

  const makeInnerDriver = (): SnugDbDriver =>
    createDbDriver({
      backend: materializerBackend,
      ...(options.locateWasm !== undefined ? { locateWasm: options.locateWasm } : {}),
      ...(options.wasmBinary !== undefined ? { wasmBinary: options.wasmBinary } : {}),
      persistDebounceMs: debounceMs,
    });

  let inner = makeInnerDriver();

  /**
   * Apps deleted in this session. A running iframe does NOT stop when its app is deleted,
   * and its next db frame used to re-register the namespace (noteNamespace) and re-create
   * the app's tables plus an ORPHANED snug_app_schemas row on the following write-back —
   * the app looked deleted in listApps() while its data quietly lived on in the file.
   * Deletion is terminal: frames for a dead app are refused rather than resurrecting it.
   */
  const deletedApps = new Set<string>();

  /** Stable facade so `userDb.driver` survives importUserDb swapping the inner driver. */
  const driver: SnugDbDriver = {
    handle: (namespace, request) => {
      if (deletedApps.has(namespace)) {
        return Promise.resolve({
          ok: false as const,
          code: USERDB_ERROR_CODES.NOT_FOUND,
          message: `app "${namespace}" was deleted`,
          retryable: false,
        });
      }
      noteNamespace(namespace);
      return inner.handle(namespace, request);
    },
    get persistence() {
      return inner.persistence;
    },
    flush: () => inner.flush(),
    evict: (namespace) => inner.evict(namespace),
    close: () => inner.close(),
  };

  /** Internal db-request frames for applyAppDdl's snapshot/exec/restore round trip. */
  let internalSeq = 0;
  const internalFrame = (fields: Record<string, unknown>): DbRequestFrame =>
    ({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbRequest,
      requestId: `userdb-internal-${++internalSeq}`,
      instanceId: 'userdb-internal',
      ...fields,
    }) as DbRequestFrame;

  // ------------------------------------------------------------------------- apps

  const toAppRecord = (row: unknown[]): AppRecord => ({
    appId: String(row[0]),
    displayName: String(row[1]),
    ...(row[2] !== null && row[2] !== undefined ? { description: String(row[2]) } : {}),
    ...(row[3] !== null && row[3] !== undefined ? { iconEmoji: String(row[3]) } : {}),
    ...(row[4] !== null && row[4] !== undefined ? { iconColor: String(row[4]) } : {}),
    usesDb: row[5] === 1,
    currentVersion: Number(row[6]),
    createdAt: String(row[7]),
    updatedAt: String(row[8]),
    ...(row[9] !== null && row[9] !== undefined ? { installSource: String(row[9]) } : {}),
  });

  const APP_COLUMNS =
    'app_id, display_name, description, icon_emoji, icon_color, uses_db, current_version, created_at, updated_at, install_source';

  function getApp(appId: string): AppRecord | undefined {
    assertOpen();
    const rows = select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
    const row = rows[0];
    return row === undefined ? undefined : toAppRecord(row);
  }

  function getAppByInstallSource(source: string): AppRecord | undefined {
    assertOpen();
    const rows = select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} WHERE install_source = ?`, [source]);
    const row = rows[0];
    return row === undefined ? undefined : toAppRecord(row);
  }

  /**
   * Raw contract text for a version row — the pre-validation bytes, used by copy-forward
   * (which must move a row verbatim, not re-serialize it) and by the import comparison.
   */
  function rawRuntimeContract(appId: string, version: number): string | null {
    const raw = select(
      `SELECT runtime_contract_json FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version = ?`,
      [appId, version],
    )[0]?.[0];
    return raw === null || raw === undefined ? null : String(raw);
  }

  function insertVersion(
    appId: string,
    version: number,
    html: string,
    note: string | undefined,
    pinned: boolean,
    /**
     * The version to COPY THE RUNTIME CONTRACT FORWARD FROM (ADR-0018 D2(i–ii)).
     *
     * Explicit rather than "always the current version" on purpose. `revertApp` and
     * `resetToFactory` both land their new version through here, and for them the correct
     * source is the version being restored — copying the CURRENT one would run reverted
     * HTML under the contract the user just backed out of (fold F-B1). Passing `undefined`
     * means "no contract", which is how a fresh install starts.
     */
    contractSourceVersion: number | undefined,
  ): AppVersionMeta {
    const createdAt = now();
    const contractJson =
      contractSourceVersion === undefined ? null : rawRuntimeContract(appId, contractSourceVersion);
    run(
      `INSERT INTO ${USERDB_TABLES.appVersions} (app_id, version, html, note, created_at, pinned, runtime_contract_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [appId, version, html, note ?? null, createdAt, pinned ? 1 : 0, contractJson],
    );
    // Retention: the newest N unpinned versions plus every pinned (factory) version.
    run(`DELETE FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version <= ? AND pinned = 0`, [
      appId,
      version - retained,
    ]);
    return { version, ...(note !== undefined ? { note } : {}), createdAt, htmlBytes: html.length, pinned };
  }

  const userDb: UserDb = {
    get persistence(): DbPersistence {
      return backend.kind === 'memory' ? 'none' : backend.kind;
    },
    driver,

    installApp(input) {
      assertOpen();
      if (input.installSource !== undefined) {
        const existing = getAppByInstallSource(input.installSource);
        if (existing !== undefined) return existing; // find-or-open: never duplicate an install identity
      }
      guardAddedBytes(input.html.length, `installing "${input.displayName}"`);
      const appId = input.appId ?? crypto.randomUUID();
      const timestamp = now();
      try {
        run(`INSERT INTO ${USERDB_TABLES.apps} (${APP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          appId,
          input.displayName,
          input.description ?? null,
          input.iconEmoji ?? null,
          input.iconColor ?? null,
          input.usesDb === true ? 1 : 0,
          1,
          timestamp,
          timestamp,
          input.installSource ?? null,
        ]);
      } catch (err) {
        // Unique-index backstop: a racing install of the same source connects to the winner.
        if (input.installSource !== undefined) {
          const existing = getAppByInstallSource(input.installSource);
          if (existing !== undefined) return existing;
        }
        throw err;
      }
      // v1 = the pinned factory version. No contract source: a fresh install has no prior
      // version, and its contract (if any) is written by the authoring turn that follows.
      insertVersion(appId, 1, input.html, input.note, true, undefined);
      return getApp(appId) as AppRecord;
    },

    saveAppVersion(appId, html, note, contractSourceVersion, opts) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      guardAddedBytes(html.length, `new version of "${appId}"`);
      // An explicit contract (the starter-update act, ADR-0045) validates BEFORE any row
      // is written — same boundary rule as `putRuntimeContract`, and failing here leaves
      // the app untouched rather than stranding a contract-less pinned version.
      const explicitContractJson =
        opts?.contract === undefined ? undefined : JSON.stringify(runtimeContractSchema.parse(opts.contract));
      if (explicitContractJson !== undefined) {
        guardAddedBytes(explicitContractJson.length, `runtime contract of "${appId}"`);
      }
      const version = app.currentVersion + 1;
      // COPY-FORWARD (ADR-0018 D2(i)): an ordinary edit inherits the current version's
      // contract, so a cosmetic change never strands it and the P2 synthesis trigger stays
      // scoped to apps that genuinely have none (fold F-B1). Revert/reset override the
      // source with the version they are restoring; a starter update overrides it with
      // the starter's own contract (ADR-0045 — a factory update ships factory contract).
      const meta = insertVersion(
        appId,
        version,
        html,
        note,
        opts?.pinned === true,
        contractSourceVersion ?? app.currentVersion,
      );
      if (explicitContractJson !== undefined) {
        run(`UPDATE ${USERDB_TABLES.appVersions} SET runtime_contract_json = ? WHERE app_id = ? AND version = ?`, [
          explicitContractJson,
          appId,
          version,
        ]);
      }
      run(`UPDATE ${USERDB_TABLES.apps} SET current_version = ?, updated_at = ? WHERE app_id = ?`, [
        version,
        now(),
        appId,
      ]);
      return meta;
    },

    updateAppMeta(appId, patch) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      const merged = { ...app, ...patch };
      run(
        `UPDATE ${USERDB_TABLES.apps}
         SET display_name = ?, description = ?, icon_emoji = ?, icon_color = ?, uses_db = ?, updated_at = ?
         WHERE app_id = ?`,
        [
          merged.displayName,
          merged.description ?? null,
          merged.iconEmoji ?? null,
          merged.iconColor ?? null,
          merged.usesDb === true ? 1 : 0,
          now(),
          appId,
        ],
      );
    },

    listApps() {
      assertOpen();
      return select(`SELECT ${APP_COLUMNS} FROM ${USERDB_TABLES.apps} ORDER BY updated_at DESC, app_id`).map(
        toAppRecord,
      );
    },

    getApp,
    getAppByInstallSource,

    /**
     * Remove an installed app and everything that references it, in ONE transaction.
     *
     * There are NO foreign keys in the user DB and `PRAGMA foreign_keys` is never set,
     * so this cascade is entirely hand-written: every referencing table is named below.
     * A table missing from that list is a SILENT orphan — the delete-app tests sweep all
     * of them independently rather than trusting this list.
     *
     * Two things this deliberately does NOT do:
     *  - It does not honour `pinned`. The factory version and the bootstrap chat message
     *    are removed with everything else (owner-confirmed). That is exactly why the
     *    retention helpers (`pruneChatMessages`, version retention) are NOT reused here:
     *    both refuse pinned rows by design.
     *  - It does not persist the app's runtime copy on the way out. The materializer's
     *    `writeBack` rebuilds rest tables from the still-open runtime database on flush,
     *    so a normal close/flush would RESURRECT the app. The namespace is evicted (not
     *    flushed) and its cached mappings dropped before the transaction commits.
     */
    async deleteApp(appId) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      const token = appDataToken(appId);
      const blobFile = namespaceToFileName(appId);

      // Flush BEFORE evicting. `evict` discards the app's in-memory runtime without
      // persisting, so anything written since the last write-back would be gone — and if
      // the transaction below then rolls back, the app survives having SILENTLY lost its
      // most recent writes (ROLLBACK restores the rest tables, but that delta was never
      // in them). Flushing first puts the delta into the rest tables, where the rollback
      // covers it; the delete then drops those tables anyway on the success path.
      await inner.flush();

      // Then evict: the driver holds an open sql.js copy of this app's runtime, and its
      // write-back is the resurrection hazard. Both happen before BEGIN IMMEDIATE, so a
      // failure in either aborts with the app fully intact.
      await inner.evict(appId);

      db.run('BEGIN IMMEDIATE');
      try {
        // 1. The app's native data tables (app_<token>__*), read from sqlite_master.
        for (const rest of restTablesFor(token)) {
          db.run(`DROP TABLE IF EXISTS ${quoteIdent(rest)}`);
        }
        // 2. Chat messages first — they join through thread_id, so the threads they
        //    depend on must still be present to resolve them.
        db.run(
          `DELETE FROM ${USERDB_TABLES.chatMessages} WHERE thread_id IN (SELECT thread_id FROM ${USERDB_TABLES.chatThreads} WHERE app_id = ?)`,
          [appId],
        );
        // 3. Every remaining app_id-keyed table. Unconditional — `pinned` is ignored.
        for (const table of [
          USERDB_TABLES.chatThreads,
          USERDB_TABLES.appDocs,
          USERDB_TABLES.appVersions,
          USERDB_TABLES.appMigrations,
          USERDB_TABLES.appSchemas,
          // v4: the app's connection rows go with it. Tombstones included — a `revoked`
          // row exists to tell the user about an app they still have; once the app is
          // gone there is nobody left to tell, and leaving it would resurrect a stale
          // tombstone against a reused id and count against the slot cap forever.
          USERDB_TABLES.connections,
        ]) {
          db.run(`DELETE FROM ${table} WHERE app_id = ?`, [appId]);
        }
        // 3b. The app's slice of the auth secrets namespace (`auth:<appId>:*` —
        //     credential values + connection state). The per-user `auth:_state_hmac`
        //     and `auth:_flow:*` keys are NOT app-keyed and survive.
        //     Known limit (review finding 3, cosmetic): an appId containing a literal
        //     colon would make this prefix over-match a sibling id sharing that prefix
        //     — unreachable with crypto.randomUUID() app ids; revisit only if app-id
        //     shapes ever widen.
        const prefix = authAppSecretPrefix(appId).replace(/([!%_])/g, '!$1');
        db.run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key LIKE ? ESCAPE '!'`, [`${prefix}%`]);
        // 3c. The app's per-app model pick (TASK-20260817). `snug_settings` is a
        //     hub-level KV holding global keys (`mode`, `provider`, `model`, …) plus
        //     these ONE-PER-APP `appModel:<appId>` rows, so — unlike the tables above —
        //     it cannot be swept by `app_id`. This is an EQUALITY match on the single
        //     key, deliberately not a `LIKE 'appModel:%'` prefix delete: there is exactly
        //     one row per app, and equality needs no metacharacter escaping and cannot
        //     over-match a sibling id (the caveat noted for the secrets prefix above).
        db.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [appModelSettingKey(appId)]);
        //     … and the starter-version row (ADR-0045 §6), the second one-per-app key in
        //     this namespace — same equality-delete rationale as above.
        db.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [starterVersionSettingKey(appId)]);
        //     … and the per-app provider pin + user-rename marker (TASK-20260821), the
        //     third and fourth one-per-app keys — same rationale, mutation-checked by
        //     app-provider-setting.test.ts.
        db.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [appProviderSettingKey(appId)]);
        db.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [appRenamedSettingKey(appId)]);
        //     … and the share rows (TASK-20260904, ADR-0063): the one-per-app installed
        //     bundle marker by equality, and the MANY-per-app minted-link records by the
        //     same escaped prefix delete the `auth:` slice uses — mutation-checked by
        //     app-bundle.test.ts.
        db.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [sharedBundleSettingKey(appId)]);
        const linkPrefix = shareLinkSettingPrefixFor(appId).replace(/([!%_])/g, '!$1');
        //     … whose `share:<linkId>` SECRETS (revoke token + key) go with them (Gate-5
        //     finding 10): read the link ids from the rows being deleted, then delete
        //     each secret by equality. A surviving secret would keep a link the user has
        //     no surface left to revoke.
        const linkIds = selectRows(db, `SELECT key FROM ${USERDB_TABLES.settings} WHERE key LIKE ? ESCAPE '!'`, [
          `${linkPrefix}%`,
        ]).map((row) => String(row[0]).slice(shareLinkSettingPrefixFor(appId).length));
        for (const linkId of linkIds) {
          db.run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [`share:${linkId}`]);
        }
        db.run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key LIKE ? ESCAPE '!'`, [`${linkPrefix}%`]);
        // 3d. The sidecar identity directory, when this app held the LAST approved
        //     sidecar-ceiling connection (TASK-20260820, R-9 lifecycle). Inside the
        //     transaction: the check reads the connection rows step 3 just deleted, so
        //     it must commit or roll back with them.
        wipeSidecarIdentityDirectoryIfOrphaned(db);
        // 4. The app row last, so a failure above leaves a consistent, still-installed app.
        db.run(`DELETE FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
        db.run('COMMIT');
      } catch (err) {
        try {
          db.run('ROLLBACK');
        } catch {
          /* nothing to roll back */
        }
        throw err;
      }

      // Drop the materializer's caches for this namespace only AFTER the commit: while
      // the transaction could still roll back, these mappings must stay valid.
      // Second, independent guard against R1. Mutation-tested: the eviction above and
      // this invalidation each stop the resurrection ON THEIR OWN — the app data tables
      // only come back if BOTH are removed. Deliberately redundant, because they fail in
      // different directions: eviction drops the driver's cached runtime copy, while
      // this makes the materializer's `save` a no-op for a namespace it no longer knows.
      // Keep both.
      namespaceByFile.delete(blobFile);
      lastSavedHash.delete(blobFile);
      // Terminal: a still-running iframe's next frame must not re-register this namespace.
      deletedApps.add(appId);
      // Durability BEFORE the space reclaim: the delete is already committed in memory, so
      // it must reach the backend even if the VACUUM below fails. Ordering these the other
      // way round left a committed-but-unpersisted delete whenever VACUUM threw.
      markDirty();
      // VACUUM outside the transaction (SQLite forbids it inside one). Dropping the
      // rows only marks their pages free — the app's HTML, chat and docs would still sit
      // in the file, readable in the exported bytes. The same reasoning already applies
      // to stripped secrets in exportUserDb; here it must happen at the source so EVERY
      // export path benefits, including includeSecrets.
      // Best-effort: VACUUM allocates a full second copy of the database, so it is the one
      // statement here likely to fail under memory pressure — exactly the condition a large
      // delete creates. A failed space reclaim must never fail an already-committed delete;
      // the freed pages just get reused later instead.
      try {
        db.run('VACUUM');
      } catch {
        /* space reclaim is an optimization, not part of the delete's contract */
      }
      await persistNow();
    },

    getAppHtml(appId, version) {
      assertOpen();
      const target = version ?? getApp(appId)?.currentVersion;
      if (target === undefined) return undefined;
      const rows = select(`SELECT html FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version = ?`, [
        appId,
        target,
      ]);
      const html = rows[0]?.[0];
      return html === undefined ? undefined : String(html);
    },

    listAppVersions(appId) {
      assertOpen();
      return select(
        `SELECT version, note, created_at, length(html), pinned FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? ORDER BY version DESC`,
        [appId],
      ).map((row) => ({
        version: Number(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { note: String(row[1]) } : {}),
        createdAt: String(row[2]),
        htmlBytes: Number(row[3]),
        pinned: row[4] === 1,
      }));
    },

    revertApp(appId, toVersion) {
      assertOpen();
      const html = this.getAppHtml(appId, toVersion);
      if (html === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" has no version ${toVersion}`);
      }
      // The contract comes from the TARGET version, not the current one (ADR-0018 D2(ii)):
      // reverted HTML must run under the contract that shipped with it. Reverting to a
      // contract-less version therefore clears the contract, which is the same rule read
      // in the other direction.
      return this.saveAppVersion(appId, html, `revert to v${toVersion}`, toVersion);
    },

    resetToFactory(appId) {
      assertOpen();
      // NEWEST pinned version, not oldest (ADR-0045): after a starter update lands a
      // second factory pin, "reset to factory" means the starter you are on — restoring
      // install-day bytes would re-strand the user on exactly the stale copy the update
      // channel exists to retire (lessons.md 2026-08-19). Single-pin apps are unaffected.
      const factory = select(
        `SELECT MAX(version) FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND pinned = 1`,
        [appId],
      )[0]?.[0];
      if (typeof factory !== 'number') {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" has no pinned factory version`);
      }
      const html = this.getAppHtml(appId, factory);
      if (html === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `factory version ${factory} of "${appId}" is missing`);
      }
      return this.saveAppVersion(appId, html, `reset to factory (v${factory})`, factory);
    },

    deleteAppVersion(appId, version) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      const row = select(
        `SELECT pinned FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version = ?`,
        [appId, version],
      )[0];
      // Unknown FIRST: current is always MAX(version) (saveAppVersion lands current as the
      // new maximum), so a too-high number must read as "no such version", never as a
      // current-version refusal about a row that does not exist.
      if (row === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `app "${appId}" has no version ${version}`);
      }
      // Pinned BEFORE current: a pin is the permanent claim (reset-to-factory and the
      // ADR-0045 vouch chain both address pins), so a pinned-and-current row names the
      // reason that will still be true after the user reverts elsewhere.
      if (row[0] === 1) {
        throw new UserDbError(
          USERDB_ERROR_CODES.VERSION_PINNED,
          `v${version} of "${appId}" is a pinned factory version and cannot be deleted`,
        );
      }
      if (version === app.currentVersion) {
        throw new UserDbError(
          USERDB_ERROR_CODES.VERSION_CURRENT,
          `v${version} of "${appId}" is the running version — revert to another version first`,
        );
      }
      run(`DELETE FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version = ?`, [appId, version]);
      // No VACUUM here, deliberately: version HTML is not secret-bearing (unlike the
      // credential bytes deleteApp reclaims), and the next deleteApp/export VACUUM frees
      // the pages. Running a full-file VACUUM per row delete would be all cost.
      markDirty();
    },

    // ---------------------------------------------------------- runtime contracts

    getRuntimeContract(appId, version) {
      assertOpen();
      const target = version ?? getApp(appId)?.currentVersion;
      if (target === undefined) return undefined;
      // `parseRuntimeContract` is the TOLERANT read: a corrupt or over-bound stored row
      // reads as "no contract" so the app degrades to the lean generic layers rather than
      // failing its turn (AC-F1-4).
      return parseRuntimeContract(rawRuntimeContract(appId, target));
    },

    putRuntimeContract(appId, version, contract) {
      assertOpen();
      const app = getApp(appId);
      if (app === undefined) throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      // Validate BEFORE writing: this row is rendered into the system slot of every
      // runtime turn, so the write boundary is the right place to fail an over-bound or
      // malformed contract loudly (bounds-at-parse, D2).
      const json = contract === undefined ? null : JSON.stringify(runtimeContractSchema.parse(contract));
      if (json !== null) guardAddedBytes(json.length, `runtime contract of "${appId}"`);
      run(`UPDATE ${USERDB_TABLES.appVersions} SET runtime_contract_json = ? WHERE app_id = ? AND version = ?`, [
        json,
        appId,
        version,
      ]);
      markDirty();
    },

    // --------------------------------------------------------- scratch execution

    async scratchRun(appId, statements) {
      assertOpen();
      if (getApp(appId) === undefined) {
        // A typo must not silently query an empty database and answer "you have no
        // expenses" — that reads as data, not as an error.
        throw new UserDbError(USERDB_ERROR_CODES.NOT_FOUND, `unknown app "${appId}"`);
      }
      const results: ScratchStatementResult[] = [];
      if (statements.length === 0) return { statements: results };

      // Export the app's materialized bytes and open them in an INDEPENDENT sql.js
      // instance. This is the whole isolation story: hub tables and other apps' tables
      // were never in these bytes (ADR-0010 materialization), and nothing writes this
      // instance back — the driver's save path only ever runs on ITS own handles.
      const snapshot = await driver.handle(appId, internalFrame({ op: 'export' }));
      if (!snapshot.ok || snapshot.bytesBase64 === undefined) {
        const detail = snapshot.ok ? 'no bytes' : snapshot.message;
        throw new UserDbError(USERDB_ERROR_CODES.SCRATCH_UNAVAILABLE, `cannot snapshot app runtime: ${detail}`);
      }
      const scratchBytes = base64ToBytes(snapshot.bytesBase64);
      if (scratchBytes === undefined) {
        throw new UserDbError(USERDB_ERROR_CODES.SCRATCH_UNAVAILABLE, 'app runtime snapshot was not valid base64');
      }
      const scratch = new SQL.Database(scratchBytes);
      try {
        for (const entry of statements) {
          // The SAME guards as the real executor, from the same function (D7).
          const forbidden = forbiddenStatementReason(entry.sql);
          if (forbidden !== undefined) {
            results.push({ error: `forbidden statement: ${forbidden}` });
            break;
          }
          let statement;
          try {
            const iterator = scratch.iterateStatements(entry.sql);
            const first = iterator.next();
            if (first.done === true) {
              results.push({ error: 'no SQL statement to execute' });
              break;
            }
            statement = first.value;
            if (!isSqlTailEmpty(iterator.getRemainingSQL())) {
              results.push({
                error:
                  'exec accepts exactly one SQL statement — split multi-statement scripts into separate entries',
              });
              break;
            }
            const params = entry.params;
            if (params !== undefined && params.length > 0) {
              statement.bind(params.map((p) => (p === undefined ? null : p)) as BindParams);
            }
            const columns = statement.getColumnNames();
            const rows: unknown[][] = [];
            let totalRows = 0;
            let truncated = false;
            let bytes = 0;
            while (statement.step()) {
              totalRows += 1;
              if (truncated) continue; // keep counting so `totalRows` is honest
              const row = (statement.get() as unknown[]).map(normalizeCell);
              // Byte cap checked BEFORE keeping the row: a single fat row must not push
              // the payload past the cap it exists to enforce.
              bytes += JSON.stringify(row).length;
              if (rows.length >= MAX_QUERY_ROWS || bytes > MAX_QUERY_RESULT_BYTES) {
                truncated = true;
                continue;
              }
              rows.push(row);
            }
            /**
             * `getRowsModified()` is `sqlite3_changes()` — the count for the LATEST
             * completed statement, NOT a running total for the connection.
             *
             * This was implemented as a delta against a previous reading, which is right
             * only for the first write and produces NEGATIVE counts afterwards (verified:
             * DELETE 2 rows then UPDATE 1 row reported `[2, -1]`). The approval card
             * rendered that number, and the TOCTOU drift check could not catch it because
             * it re-ran the same arithmetic on both sides and got the same wrong answer.
             * Found by the P4 whole-surface review; regression-tested in scratch-run.
             *
             * The count is attached to every MODIFYING statement, including one with a
             * `RETURNING` clause. Keying it on `columns.length === 0` meant a
             * `DELETE … RETURNING id` carried rows but no count, so the card said
             * "0 row(s)" for a destructive statement and drift could never fire for it —
             * and the statement text is the model's to choose.
             *
             * But `sqlite3_changes()` is also STICKY (R-M1, 2026-08-11): it keeps
             * reporting the last modifying statement's count for every statement that
             * follows. A `DELETE` then `SELECT` batch therefore previewed as `[3, 3]`,
             * and the approval card told the user a SELECT would change 3 rows. Worse,
             * that second number is not an independent measurement — it is a copy of the
             * first — so the TOCTOU drift check could never derive a real signal from it.
             *
             * The discriminator is the statement's KIND, not a runtime counter: a DELETE
             * matching nothing must still report 0 (the user needs to see it), while a
             * SELECT must report nothing at all. `total_changes()` cannot tell those two
             * apart — both leave it untouched — which is why this keys off the verb.
             */
            const modifies = isRowModifyingStatement(entry.sql);
            results.push({
              ...(columns.length > 0 ? { rows, columns } : {}),
              ...(modifies ? { changes: scratch.getRowsModified() } : {}),
              ...(truncated ? { truncated, totalRows } : {}),
            });
          } catch (err) {
            results.push({ error: errorMessage(err) });
            break;
          } finally {
            statement?.free();
          }
        }
      } finally {
        scratch.close(); // the copy — and every mutation made to it — is discarded here
      }
      return { statements: results };
    },

    // ------------------------------------------------------------- schema registry

    getAppSchema(appId) {
      assertOpen();
      const raw = select(`SELECT schema_json FROM ${USERDB_TABLES.appSchemas} WHERE app_id = ?`, [appId])[0]?.[0];
      return raw === undefined ? undefined : (JSON.parse(String(raw)) as AppSchemaJson);
    },

    async applyAppDdl(appId, statements) {
      assertOpen();
      if (statements.length === 0) return this.getAppSchema(appId) ?? { objects: [] };
      const snapshot = await driver.handle(appId, internalFrame({ op: 'export' }));
      if (!snapshot.ok || snapshot.bytesBase64 === undefined) {
        const detail = snapshot.ok ? 'no bytes' : snapshot.message;
        throw new UserDbError(USERDB_ERROR_CODES.DDL_FAILED, `cannot snapshot app runtime: ${detail}`);
      }
      const restore = async (): Promise<void> => {
        await driver.handle(appId, internalFrame({ op: 'import', bytesBase64: snapshot.bytesBase64 }));
      };
      for (const [index, sql] of statements.entries()) {
        const result = await driver.handle(appId, internalFrame({ op: 'exec', sql }));
        if (!result.ok) {
          await restore();
          throw new UserDbError(
            USERDB_ERROR_CODES.DDL_FAILED,
            `statement ${index + 1} failed (runtime restored): ${result.message}`,
          );
        }
      }
      // Pre-validate the post-batch runtime with the same gate the write-back uses, so a
      // bad name surfaces HERE as a typed error instead of a background persist failure.
      const master = await driver.handle(
        appId,
        internalFrame({ op: 'exec', sql: 'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL' }),
      );
      if (master.ok && master.rows !== undefined) {
        for (const row of master.rows) {
          const name = String(row[1]);
          if (name.toLowerCase().startsWith('sqlite_') || name === APP_KV_TABLE) continue;
          if (!isValidAppObjectName(name)) {
            await restore();
            throw new UserDbError(
              USERDB_ERROR_CODES.INVALID_NAME,
              `proposed DDL creates ${JSON.stringify(name)}, which violates the naming rule (runtime restored)`,
            );
          }
          // Same gate the write-back applies (review O4) — surface it HERE as a typed error.
          if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(row[2] ?? '').trim())) {
            await restore();
            throw new UserDbError(
              USERDB_ERROR_CODES.INVALID_NAME,
              `virtual tables are not portable — "${name}" cannot be persisted (runtime restored)`,
            );
          }
        }
      }
      await inner.flush(); // write-back registers the schema transactionally
      const nextSeq = Number(
        select(`SELECT COALESCE(MAX(seq), 0) FROM ${USERDB_TABLES.appMigrations} WHERE app_id = ?`, [appId])[0]?.[0] ?? 0,
      );
      const appliedAt = now();
      statements.forEach((sql, index) => {
        run(`INSERT INTO ${USERDB_TABLES.appMigrations} (app_id, seq, ddl, applied_at) VALUES (?, ?, ?, ?)`, [
          appId,
          nextSeq + index + 1,
          sql,
          appliedAt,
        ]);
      });
      return this.getAppSchema(appId) ?? { objects: [] };
    },

    listAppMigrations(appId) {
      assertOpen();
      return select(
        `SELECT seq, ddl, applied_at FROM ${USERDB_TABLES.appMigrations} WHERE app_id = ? ORDER BY seq`,
        [appId],
      ).map((row) => ({ seq: Number(row[0]), ddl: String(row[1]), appliedAt: String(row[2]) }));
    },

    // --------------------------------------------------- connections (Dynamic Auth v2)

    putDeclaredConnection(appId, slot, requirement, provenance, opts = {}) {
      assertOpen();
      // Parse FIRST, before any row is read or written. Provenance is validated through
      // the same schema pass rather than trusted from the TypeScript signature: a
      // JavaScript caller (or a JSON round trip) can hand over `'llm_guess'` and the
      // compiler will never see it.
      // Provenance IS the admission channel — the argument the caller already supplies —
      // so admission needs no new parameter and cannot drift from what gets persisted in
      // the `provenance` column.
      const validated = admitAndParse(requirement, appId, slot, provenance);
      if (!CONNECTION_PROVENANCES.includes(provenance)) {
        throw new UserDbError(
          USERDB_ERROR_CODES.INVALID_CONNECTION_REQUIREMENT,
          `unknown connection provenance ${JSON.stringify(provenance)}`,
        );
      }
      const requirementJson = JSON.stringify(validated);
      const unionJson = JSON.stringify(deriveConnectionAllowedHosts(validated));
      guardAddedBytes(requirementJson.length + unionJson.length, `connection "${appId}/${slot}"`);

      const existing = readConnectionRow(appId, slot);
      const timestamp = now();
      if (existing === undefined) {
        // The row-count cap applies to NEW slots only (fold S-M1). Counting on the
        // replace path too would refuse the legitimate R3 re-inference of an existing
        // slot at exactly the cap — a build that is doing nothing wrong.
        const held = Number(
          select(`SELECT COUNT(*) FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ?`, [appId])[0]?.[0] ?? 0,
        );
        // Revoked tombstones are counted deliberately: they are exactly what a flooding
        // build leaves behind, and the revoke path keeps the row by design, so excluding
        // them would hand back an unbounded budget for the price of a revoke.
        if (held >= AUTH_MAX_SLOTS_PER_APP) {
          throw new ConnectionSlotCapExceeded(appId, slot, AUTH_MAX_SLOTS_PER_APP);
        }
        run(
          `INSERT INTO ${USERDB_CONNECTIONS_TABLE} (${CONNECTION_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, NULL, ?, ?)`,
          [
            appId,
            slot,
            requirementJson,
            1,
            provenance,
            opts.confidence ?? null,
            CONNECTION_STATUS.declared,
            unionJson,
            timestamp,
            timestamp,
          ],
        );
        return readConnectionRow(appId, slot)!;
      }

      // Status gates, checked in tombstone-first order so a revoked row reports the
      // remedy the user actually needs rather than "use stagePendingRequirement".
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      if (existing.status === CONNECTION_STATUS.approved) {
        throw new ConnectionWriteRuleViolation(
          appId,
          slot,
          existing.status,
          'a changed requirement must be staged with stagePendingRequirement and re-approved by the user',
        );
      }
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET requirement_json = ?, requirement_version = ?, provenance = ?, confidence = ?,
             allowed_hosts = ?, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [
          requirementJson,
          nextRequirementVersion(existing.requirement, validated, existing.requirementVersion),
          provenance,
          opts.confidence ?? null,
          unionJson,
          timestamp,
          appId,
          slot,
        ],
      );
      return readConnectionRow(appId, slot)!;
    },

    stagePendingRequirement(appId, slot, requirement) {
      assertOpen();
      // The row is read BEFORE admission here (unlike the declare path) because the
      // channel is not an argument on this accessor — a staged edit inherits the row's
      // stored `provenance`, which is the channel that authored the connection. Reading
      // it first is what makes admission possible at all; nothing is written until every
      // guard below has passed.
      const existing = requireConnectionRow(appId, slot);
      const validated = admitAndParse(requirement, appId, slot, existing.provenance);
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      if (existing.status !== CONNECTION_STATUS.approved) {
        throw new ConnectionWriteRuleViolation(
          appId,
          slot,
          existing.status,
          'only an approved row has a grant worth protecting; replace a declared row with putDeclaredConnection',
        );
      }
      const pendingJson = JSON.stringify(validated);
      guardAddedBytes(pendingJson.length, `pending requirement for "${appId}/${slot}"`);
      // ONLY the pending column moves. `allowed_hosts`, `requirement_json`, `status`,
      // `approved_at` and `requirement_version` are all left alone ON PURPOSE (fold B2):
      // the grant must keep serving EXACTLY what the user approved while the edit waits,
      // so an edit that widens the host set cannot widen the live ceiling by staging.
      // The version does not move either — a staged requirement is not yet persisted
      // INTO the grant; `reapproveConnection` bumps it at promotion.
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE} SET pending_requirement_json = ?, updated_at = ? WHERE app_id = ? AND slot = ?`,
        [pendingJson, now(), appId, slot],
      );
      return readConnectionRow(appId, slot)!;
    },

    approveConnection(appId, slot) {
      assertOpen();
      const existing = requireConnectionRow(appId, slot);
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      // Re-validate the STORED requirement at the trust boundary: a row written by a
      // newer hub, or one that arrived through an import, stays unapprovable until a hub
      // that understands it runs. Same fail-closed posture as `approveAuthSpec`.
      const validated = parseConnectionRequirementStrict(existing.requirement);
      // A staged pending edit is DISCARDED here, not preserved and not promoted (review
      // MAJOR-3). `approveConnection` re-affirms the CURRENT requirement — it derives its
      // ceiling from `existing.requirement` and never reads the pending column — so a
      // staged edit that survived this call would be an edit the user did not act on,
      // sitting in the seat the next `reapproveConnection` promotes. Two concrete harms
      // followed: the derived "needs re-approval" pill read TRUE on a row the user had
      // just approved, and a later promotion carried a requirement that borrowed the
      // legitimacy of an approval which was never about it.
      //
      // CLEARING rather than THROWING, deliberately. Throwing would make the approve
      // button fail on a row whose pending edit the user may never have seen (an app can
      // stage one at any time), turning an attacker-triggerable state into a denial of
      // the user's own approval. Discarding is also the honest reading of the act: the
      // user approved what the screen showed them, which is the current requirement.
      // Widening remains reachable only through `reapproveConnection`, which shows the
      // staged edit and re-derives the ceiling from it.
      const timestamp = now();
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET status = ?, allowed_hosts = ?, pending_requirement_json = NULL, approved_at = ?, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [
          CONNECTION_STATUS.approved,
          // Derived here and stored verbatim. The import reconciliation compares these
          // exact bytes against a fresh derivation, so "what approval stored" and "what
          // derivation produces" must be the same function's output — never a
          // re-serialization of the column.
          JSON.stringify(deriveConnectionAllowedHosts(validated)),
          timestamp,
          timestamp,
          appId,
          slot,
        ],
      );
      return readConnectionRow(appId, slot)!;
    },

    reapproveConnection(appId, slot) {
      assertOpen();
      const existing = requireConnectionRow(appId, slot);
      if (existing.status === CONNECTION_STATUS.revoked) {
        throw new ConnectionRevokedError(appId, slot, existing.revokedAt);
      }
      // Promote pending when there is one; re-approving without a staged edit is a
      // legitimate act too (the user re-confirming an unchanged grant), and it must not
      // bump the version — `nextRequirementVersion` handles both by comparison.
      //
      // The slot is re-checked HERE, not just at the staging accessors, because promotion
      // is the moment a pending requirement becomes the SERVED grant, and the pending
      // column is reachable without passing `stagePendingRequirement`: a row written by an
      // older hub, or one that arrived through an import, can hold a foreign slot no
      // current accessor validated (review MINOR).
      const promoted = parseConnectionRequirementForSlot(
        existing.pendingRequirement ?? existing.requirement,
        appId,
        slot,
      );
      const requirementJson = JSON.stringify(promoted);
      const unionJson = JSON.stringify(deriveConnectionAllowedHosts(promoted));
      guardAddedBytes(requirementJson.length + unionJson.length, `re-approval of "${appId}/${slot}"`);
      const timestamp = now();
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET requirement_json = ?, requirement_version = ?, status = ?, allowed_hosts = ?,
             pending_requirement_json = NULL, approved_at = ?, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [
          requirementJson,
          nextRequirementVersion(existing.requirement, promoted, existing.requirementVersion),
          CONNECTION_STATUS.approved,
          unionJson,
          timestamp,
          timestamp,
          appId,
          slot,
        ],
      );
      return readConnectionRow(appId, slot)!;
    },

    revokeConnection(appId, slot) {
      assertOpen();
      const existing = requireConnectionRow(appId, slot);
      const timestamp = now();
      // The ROW SURVIVES. Revocation is not a delete: the tombstone is what lets the
      // wizard say "you revoked this on <date>" instead of silently re-offering a
      // clean-looking connection, and it is what makes `putDeclaredConnection` able to
      // refuse an automatic re-declaration. `requirement_json` stays readable for the
      // same reason — the wizard renders what was revoked.
      run(
        `UPDATE ${USERDB_CONNECTIONS_TABLE}
         SET status = ?, revoked_at = ?, approved_at = NULL, pending_requirement_json = NULL, updated_at = ?
         WHERE app_id = ? AND slot = ?`,
        [CONNECTION_STATUS.revoked, existing.revokedAt ?? timestamp, timestamp, appId, slot],
      );
      // The VALUES go, and only this slot's. Metadata is a tombstone; credentials are
      // not — a revoked connection that kept working is the failure this closes.
      wipeConnectionSecrets(appId, slot);
      // And if that was the LAST approved sidecar-ceiling connection anywhere, the
      // harvested identity directory goes with it (TASK-20260820, R-9 lifecycle).
      wipeSidecarIdentityDirectoryIfOrphaned();
      return readConnectionRow(appId, slot)!;
    },

    getConnection(appId, slot) {
      assertOpen();
      return readConnectionRow(appId, slot);
    },

    listConnections(appId) {
      assertOpen();
      const rows =
        appId === undefined
          ? select(`SELECT ${CONNECTION_COLUMNS} FROM ${USERDB_CONNECTIONS_TABLE} ORDER BY app_id, slot`)
          : select(`SELECT ${CONNECTION_COLUMNS} FROM ${USERDB_CONNECTIONS_TABLE} WHERE app_id = ? ORDER BY slot`, [
              appId,
            ]);
      return rows.map(toConnectionRow);
    },

    // ------------------------------------------------------------------------ docs

    putAppDoc(appId, slug, doc) {
      assertOpen();
      guardAddedBytes(doc.content.length + (doc.title?.length ?? 0) + slug.length, `doc "${slug}"`);
      run(
        `INSERT INTO ${USERDB_TABLES.appDocs} (app_id, slug, title, content, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(app_id, slug) DO UPDATE SET
           title = COALESCE(excluded.title, title),
           content = excluded.content,
           updated_at = excluded.updated_at`,
        [appId, slug, doc.title ?? null, doc.content, now()],
      );
    },

    getAppDoc(appId, slug) {
      assertOpen();
      const row = select(
        `SELECT slug, title, content, updated_at FROM ${USERDB_TABLES.appDocs} WHERE app_id = ? AND slug = ?`,
        [appId, slug],
      )[0];
      if (row === undefined) return undefined;
      return {
        slug: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { title: String(row[1]) } : {}),
        content: String(row[2]),
        updatedAt: String(row[3]),
      };
    },

    listAppDocs(appId) {
      assertOpen();
      return select(
        `SELECT slug, title, content, updated_at FROM ${USERDB_TABLES.appDocs} WHERE app_id = ? ORDER BY slug`,
        [appId],
      ).map((row) => ({
        slug: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { title: String(row[1]) } : {}),
        content: String(row[2]),
        updatedAt: String(row[3]),
      }));
    },

    deleteAppDoc(appId, slug) {
      assertOpen();
      run(`DELETE FROM ${USERDB_TABLES.appDocs} WHERE app_id = ? AND slug = ?`, [appId, slug]);
    },

    // ------------------------------------------------------------------------ chat

    upsertThread(threadId, opts = {}) {
      assertOpen();
      const timestamp = now();
      run(
        `INSERT INTO ${USERDB_TABLES.chatThreads} (thread_id, app_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           app_id = COALESCE(excluded.app_id, app_id),
           title = COALESCE(excluded.title, title),
           updated_at = excluded.updated_at`,
        [threadId, opts.appId ?? null, opts.title ?? null, timestamp, timestamp],
      );
    },

    appendChatMessage(threadId, role, content, opts = {}) {
      assertOpen();
      const metaJson = opts.meta === undefined ? null : JSON.stringify(opts.meta);
      guardAddedBytes(content.length + (metaJson?.length ?? 0), 'chat message');
      this.upsertThread(threadId);
      const createdAt = now();
      run(
        `INSERT INTO ${USERDB_TABLES.chatMessages} (thread_id, role, content, created_at, pinned, meta) VALUES (?, ?, ?, ?, ?, ?)`,
        [threadId, role, content, createdAt, opts.pinned === true ? 1 : 0, metaJson],
      );
      const id = select('SELECT last_insert_rowid()')[0]?.[0];
      return {
        id: Number(id),
        threadId,
        role,
        content,
        createdAt,
        pinned: opts.pinned === true,
        ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
      };
    },

    updateChatMessageMeta(id, meta) {
      assertOpen();
      const metaJson = meta === undefined ? null : JSON.stringify(meta);
      guardAddedBytes(metaJson?.length ?? 0, 'chat message meta');
      // An unknown id updates zero rows — a stale click handler must not throw.
      run(`UPDATE ${USERDB_TABLES.chatMessages} SET meta = ? WHERE id = ?`, [metaJson, id]);
    },

    pinChatMessage(id) {
      assertOpen();
      run(`UPDATE ${USERDB_TABLES.chatMessages} SET pinned = 1 WHERE id = ?`, [id]);
    },

    pruneChatMessages(threadId, keepUnpinned) {
      assertOpen();
      run(
        `DELETE FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? AND pinned = 0 AND id NOT IN (
           SELECT id FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? AND pinned = 0 ORDER BY id DESC LIMIT ?)`,
        [threadId, threadId, keepUnpinned],
      );
    },

    getThread(threadId) {
      assertOpen();
      const row = select(
        `SELECT thread_id, app_id, title, created_at, updated_at FROM ${USERDB_TABLES.chatThreads} WHERE thread_id = ?`,
        [threadId],
      )[0];
      if (row === undefined) return undefined;
      return {
        threadId: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { appId: String(row[1]) } : {}),
        ...(row[2] !== null && row[2] !== undefined ? { title: String(row[2]) } : {}),
        createdAt: String(row[3]),
        updatedAt: String(row[4]),
      };
    },

    listThreads() {
      assertOpen();
      return select(
        `SELECT thread_id, app_id, title, created_at, updated_at FROM ${USERDB_TABLES.chatThreads} ORDER BY updated_at DESC`,
      ).map((row) => ({
        threadId: String(row[0]),
        ...(row[1] !== null && row[1] !== undefined ? { appId: String(row[1]) } : {}),
        ...(row[2] !== null && row[2] !== undefined ? { title: String(row[2]) } : {}),
        createdAt: String(row[3]),
        updatedAt: String(row[4]),
      }));
    },

    deleteThread(threadId) {
      assertOpen();
      // Messages first — they join through thread_id (same order the app cascade uses).
      run(`DELETE FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ?`, [threadId]);
      run(`DELETE FROM ${USERDB_TABLES.chatThreads} WHERE thread_id = ?`, [threadId]);
    },

    listChatMessages(threadId) {
      assertOpen();
      return select(
        `SELECT id, role, content, created_at, pinned, meta FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ? ORDER BY id`,
        [threadId],
      ).map((row) => ({
        id: Number(row[0]),
        threadId,
        role: String(row[1]) as ChatMessage['role'],
        content: String(row[2]),
        createdAt: String(row[3]),
        pinned: row[4] === 1,
        ...(row[5] !== null && row[5] !== undefined ? { meta: JSON.parse(String(row[5])) as unknown } : {}),
      }));
    },

    // ----------------------------------------------------- settings/profile/secrets

    getSetting: (key) => kvGet(USERDB_TABLES.settings, key),
    setSetting: (key, value) => kvSet(USERDB_TABLES.settings, key, value),
    deleteSetting(key) {
      assertOpen();
      run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]);
    },
    listSettingKeys() {
      assertOpen();
      return select(`SELECT key FROM ${USERDB_TABLES.settings} ORDER BY key`).map((row) => String(row[0]));
    },
    listAppModels() {
      assertOpen();
      const out: Record<string, string> = {};
      for (const row of select(`SELECT key, value FROM ${USERDB_TABLES.settings}`)) {
        // Parse the key rather than trusting a prefix test: `appIdFromModelSettingKey`
        // refuses a bare `appModel:` with no id, so a malformed row cannot become an
        // entry keyed by the empty string.
        const appId = appIdFromModelSettingKey(String(row[0]));
        if (appId === undefined) continue;
        const model = JSON.parse(String(row[1])) as unknown;
        // A non-string (or empty) stored value is skipped rather than surfaced: it can
        // only come from a corrupted or hand-edited file, and inheriting is the safe
        // reading — the app runs on the user's default instead of on `null`.
        if (typeof model === 'string' && model !== '') out[appId] = model;
      }
      return out;
    },
    setAppModel(appId, model) {
      assertOpen();
      const key = appModelSettingKey(appId);
      // Clearing DELETES the row instead of storing '' — absence is what "inherits the
      // global default" means, and an empty-string row would hydrate back as a falsy
      // pick that different readers could disagree about.
      if (model === undefined || model.trim() === '') {
        run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]);
        return;
      }
      kvSet(USERDB_TABLES.settings, key, model.trim());
    },
    listAppProviders() {
      assertOpen();
      const out: Record<string, string> = {};
      for (const row of select(`SELECT key, value FROM ${USERDB_TABLES.settings}`)) {
        // Same parse-don't-prefix rule as listAppModels: a bare `appProvider:` row can
        // never become an entry keyed by the empty string.
        const appId = appIdFromProviderSettingKey(String(row[0]));
        if (appId === undefined) continue;
        const provider = JSON.parse(String(row[1])) as unknown;
        // A corrupted value reads as "inherits the default" — the safe direction.
        if (typeof provider === 'string' && provider !== '') out[appId] = provider;
      }
      return out;
    },
    setAppProvider(appId, provider) {
      assertOpen();
      const key = appProviderSettingKey(appId);
      // Clearing DELETES — absence is what "follows the default provider" means.
      if (provider === undefined || provider.trim() === '') {
        run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]);
        return;
      }
      kvSet(USERDB_TABLES.settings, key, provider.trim());
    },
    listRenamedApps() {
      assertOpen();
      const out: string[] = [];
      for (const row of select(`SELECT key, value FROM ${USERDB_TABLES.settings}`)) {
        const appId = appIdFromRenamedSettingKey(String(row[0]));
        if (appId === undefined) continue;
        if ((JSON.parse(String(row[1])) as unknown) === true) out.push(appId);
      }
      return out;
    },
    setAppRenamed(appId, renamed) {
      assertOpen();
      const key = appRenamedSettingKey(appId);
      if (!renamed) {
        run(`DELETE FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]);
        return;
      }
      kvSet(USERDB_TABLES.settings, key, true);
    },
    getProfileField: (key) => kvGet(USERDB_TABLES.profile, key),
    setProfileField: (key, value) => kvSet(USERDB_TABLES.profile, key, value),

    getSecret(key) {
      assertOpen();
      const rows = select(`SELECT value FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [key]);
      const raw = rows[0]?.[0];
      return raw === undefined ? undefined : String(raw);
    },
    setSecret(key, value) {
      assertOpen();
      run(`INSERT OR REPLACE INTO ${USERDB_TABLES.secrets} (key, value) VALUES (?, ?)`, [key, value]);
    },
    deleteSecret(key) {
      assertOpen();
      run(`DELETE FROM ${USERDB_TABLES.secrets} WHERE key = ?`, [key]);
    },
    listSecretKeys() {
      assertOpen();
      return select(`SELECT key FROM ${USERDB_TABLES.secrets} ORDER BY key`).map((row) => String(row[0]));
    },

    getSyncConfig: (key) => kvGet(USERDB_TABLES.sync, key),
    setSyncConfig: (key, value) => kvSet(USERDB_TABLES.sync, key, value),

    // --------------------------------------------------------------- export/import

    async deriveAppExport(namespace) {
      assertOpen();
      const blobFile = noteNamespace(namespace);
      await inner.flush();
      const info = namespaceByFile.get(blobFile);
      if (info === undefined) return undefined;
      return materializeBytes(info);
    },

    async exportUserDb(opts = {}) {
      assertOpen();
      await inner.flush();
      await persistNow();
      const bytes = db.export();
      if (opts.includeSecrets === true) {
        if (bytes.byteLength > maxBytes) {
          throw new UserDbError(USERDB_ERROR_CODES.TOO_LARGE, `export is ${bytes.byteLength} bytes — cap is ${maxBytes}`);
        }
        return bytes;
      }
      // Strip on a throwaway copy; VACUUM so deleted secret rows leave no bytes in free pages.
      const temp = new SQL.Database(bytes);
      try {
        temp.run(`DELETE FROM ${USERDB_TABLES.secrets}`);
        temp.run('VACUUM');
        const stripped = temp.export();
        if (stripped.byteLength > maxBytes) {
          throw new UserDbError(
            USERDB_ERROR_CODES.TOO_LARGE,
            `export is ${stripped.byteLength} bytes — cap is ${maxBytes}`,
          );
        }
        return stripped;
      } finally {
        temp.close();
      }
    },

    async importUserDb(incoming, options) {
      assertOpen();
      // Unwrap a protected payload FIRST, so every guard below — the cap, the magic
      // check, the open-check, the reconciliation passes — sees ordinary SQLite bytes.
      // Doing it here rather than at each call site is what gives sync pull-merge,
      // applyRemote, recovery restore and the UI import identical behavior for free.
      let bytes = incoming;
      if (isEncryptedContainer(incoming)) {
        const opened = await decryptContainer(incoming, options?.secrets ?? {});
        if (opened.status === 'locked') {
          throw new UserDbError(
            USERDB_ERROR_CODES.LOCKED_IMPORT,
            'this Snug file is protected — enter its passphrase or Recovery Key to import it',
          );
        }
        if (opened.status === 'corrupt') {
          throw new UserDbError(USERDB_ERROR_CODES.BAD_IMPORT, `this Snug file is damaged: ${opened.reason}`);
        }
        bytes = opened.bytes;
      }
      // The cap applies to the PLAINTEXT: a container adds a header, wrapped keys, an
      // IV and a tag, so charging the user for that overhead would make a database
      // that fits become un-importable the moment they protected it (review B9).
      if (bytes.byteLength > maxBytes) {
        throw new UserDbError(USERDB_ERROR_CODES.TOO_LARGE, `import is ${bytes.byteLength} bytes — cap is ${maxBytes}`);
      }
      if (!hasSqliteMagic(bytes)) {
        throw new UserDbError(USERDB_ERROR_CODES.BAD_IMPORT, 'not a SQLite database (missing magic header)');
      }
      let next: Database | undefined;
      try {
        next = new SQL.Database(bytes);
        next.exec('SELECT count(*) FROM sqlite_master');
      } catch (err) {
        next?.close();
        throw new UserDbError(USERDB_ERROR_CODES.BAD_IMPORT, `not an openable SQLite database: ${errorMessage(err)}`);
      }
      const foundVersion = readUserVersion(next);
      if (foundVersion > USERDB_SCHEMA_VERSION) {
        next.close();
        throw new UserDbError(
          USERDB_ERROR_CODES.BAD_IMPORT,
          `user DB is schema v${foundVersion}; this hub supports up to v${USERDB_SCHEMA_VERSION}`,
        );
      }
      const importMigration = migrate(next);
      // The candidate gets the SAME schema guarantees as an opened file: the version
      // stamp it arrived with is another hub's claim, so heal against sqlite_master
      // before reading its tables, and run the v3→v4 legacy wipe on a v3-era import for
      // the same reason it runs on a v3-era open (fold T-M4) — an imported file's
      // orphaned credential slice is no less orphaned for having arrived over sync.
      healMissingTables(next);
      if (importMigration.found < USERDB_SCHEMA_VERSION) wipeLegacyAuthSlice(next);
      // Auth reconciliation (plan D5/N1 + fold T-M5): snapshot the locally-APPROVED rows
      // from the still-open handle, then run the delta-aware passes on the candidate
      // BEFORE it becomes live. Every import path (pull-merge, applyRemote, recovery
      // restore, UI import) flows through here.
      const localApprovedConnections = new Map<string, LocalApprovedConnection>();
      for (const row of select(
        `SELECT app_id, slot, requirement_json, allowed_hosts, approved_at, requirement_version
         FROM ${USERDB_CONNECTIONS_TABLE} WHERE status = ?`,
        [CONNECTION_STATUS.approved],
      )) {
        localApprovedConnections.set(connectionKey(String(row[0]), String(row[1])), {
          requirementJson: String(row[2]),
          allowedHosts: String(row[3]),
          approvedAt: row[4] === null || row[4] === undefined ? null : String(row[4]),
          requirementVersion: Number(row[5]),
        });
      }
      // Runtime contracts (ADR-0018 D2(iii)): snapshot the canonical bytes of every
      // contract this hub already holds, then refuse every imported contract that is not
      // among them. Same window as the connection pass — on the candidate, before it goes
      // live — so a foreign contract never becomes readable by a turn.
      const localContractBytes = new Set<string>();
      for (const row of select(
        `SELECT runtime_contract_json FROM ${USERDB_TABLES.appVersions} WHERE runtime_contract_json IS NOT NULL`,
      )) {
        const parsed = parseRuntimeContract(row[0] === null || row[0] === undefined ? null : String(row[0]));
        if (parsed !== undefined) localContractBytes.add(canonicalRuntimeContract(parsed));
      }
      /**
       * TRUSTED RESTORE (R-M2, 2026-08-11). Keying "known" off the open DB's contracts made
       * an EMPTY hub mean "nothing is known", so every contract was nulled — and an empty
       * hub is exactly what a legitimate restore looks like. Corruption recovery imports
       * the user's own origin image into `openFresh()`, and a new device's first
       * `pullMerge` does the same; both lost every contract permanently, since
       * `needsSynthesizedContract` only fires on first build.
       *
       * The exemption is keyed on the CALLER, not on local state. "The hub is empty" cannot
       * distinguish a restore from a hostile file — both arrive at an empty hub — so
       * inferring trust from emptiness would trade AC-F1-7 away to fix a usability bug.
       * What actually differs is provenance the caller knows and the bytes cannot forge:
       * recovery and sync pull the image from the user's OWN configured sync origin, while
       * a file the user picked off disk is an untrusted donor no matter how empty the hub.
       * So `trustedOrigin` is passed in by those two call sites and defaults to false.
       */
      const report: UserDbImportReport = {
        droppedConnections: reconcileImportedConnections(next, localApprovedConnections),
        droppedRuntimeContracts:
          options?.trustedOrigin === true
            ? []
            : reconcileImportedRuntimeContracts(next, localContractBytes),
      };
      // Close the inner driver FIRST: its cached app databases came from the old handle.
      // Its close-flush writes into the old handle, which is discarded right after.
      await inner.close();
      db.close();
      db = next;
      inner = makeInnerDriver();
      // Import replaces the WORLD, so every session cache keyed on the old handle is
      // reset as one family (the F1/R1 cache-coherence family — resetting only part of
      // it is how the restore-after-delete bug happened):
      lastSavedHash.clear(); // foreign bytes: every namespace must re-materialize
      namespaceByFile.clear(); // stale entries describe files of the discarded handle
      // Tombstones: an app the imported file CONTAINS is alive again (file-is-truth —
      // restoring a pre-delete backup must revive it). An app the file does NOT contain
      // stays tombstoned on purpose: dropping that guard would let a still-running
      // iframe of a deleted app write orphaned rest tables into the new file (R1).
      // Known limit (queued 2026-08-06 for the A10 threat model): a CRAFTED import can
      // occupy a deleted app's id and thereby drop its tombstone — unreachable by
      // accident with randomUUID ids; untrusted-import hardening owns this surface.
      for (const appId of [...deletedApps]) {
        const rows = select(`SELECT 1 FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId]);
        if (rows.length > 0) deletedApps.delete(appId);
      }
      markDirty();
      return report;
    },

    // A GETTER, not a snapshot. `protect()` reassigns `sealer` mid-session, and a
    // captured value would go stale in BOTH directions: enable protection and exports
    // keep writing plaintext while the on-disk file is sealed; disable it and exports
    // keep writing ciphertext keyed to a file that is now plaintext — an artifact its
    // owner has no reason to think needs a passphrase.
    get sealForOrigin() {
      return sealer;
    },

    async protect(secrets) {
      assertOpen();
      await inner.flush();
      await persistNow();
      // Secrets INCLUDED: this is the user's own file being protected in place, not an
      // export being handed to someone. Stripping credentials here would silently log
      // them out of every connected account the moment they turned protection on.
      const plain = db.export();
      if (secrets === undefined) {
        sealer = undefined;
        await backend.save(file, plain);
        return;
      }
      const sealed = await encryptContainer(plain, secrets);
      await backend.save(file, sealed);
      // Every LATER write re-seals into this container, so the recovery slot survives
      // a session that only ever knew the passphrase (see resealContainer).
      const keyed = await openFileKey(sealed, secrets);
      if (keyed.status === 'ok') {
        const fileKey = keyed.fileKey;
        sealer = (next: Uint8Array) => resealContainer(sealed, fileKey, next);
      }
    },

    async flush() {
      await inner.flush();
      await persistNow();
    },

    async close() {
      if (closed) return;
      lifecycleWindow?.removeEventListener?.('pagehide', onPageHide);
      lifecycleDocument?.removeEventListener?.('visibilitychange', onVisibilityChange);
      await inner.close();
      await persistNow();
      closed = true;
      db.close();
    },
  };

  return userDb;
}

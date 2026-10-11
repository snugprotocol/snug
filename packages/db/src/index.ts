// @snugprotocol/db — the per-app database: sql.js (WASM SQLite) behind the runner's
// DbDriver seam, one isolated database per host-assigned namespace, kv in `snug_kv`,
// OPFS → IndexedDB → memory persistence with debounced write-back, and real `.sqlite`
// export/import (5 MiB artifact cap, 8 MiB db frame class). Browser-safe: no node: imports.

export {
  createDbDriver,
  // The data lane's statement-class guards. Exported so the playground's write-proposal
  // handler refuses out-of-class SQL with the SAME definition the executor uses — a second
  // copy is a second thing to forget to update (R-B1).
  nonDataStatementReason,
  isRowModifyingStatement,
  // The host-side kv cap (TASK-20261009 A3): the scheduler's app input rides the handshake under it.
  HOST_KV_VALUE_MAX_BYTES,
  type CreateDbDriverOptions,
  type DbDriverResult,
  type DbPersistence,
  type DbRecoverableErrorEvent,
  type SnugDbDriver,
  type SqlJsEngineOptions,
} from './driver.js';

export { DB_ERROR_CODES, type DbErrorCode } from './errors.js';

export {
  createIdbBackend,
  createMemoryBackend,
  createOpfsBackend,
  detectPersistenceBackend,
  SYNC_SIDECAR_MAGIC,
  type MemoryBackend,
  type PersistenceBackend,
  type PersistenceKind,
} from './persistence.js';

// Desktop 'file' backend (TASK-20260812 AC2): pure-TS PersistenceBackend over an
// injected filesystem seam — the Tauri shell implements `FileBackendFs` with its
// read_user_file/write_user_file commands (temp+rename atomicity lives there).
export { createFileBackend, type FileBackendFs } from './file-backend.js';

export { namespaceToFileName } from './namespace.js';

export {
  ConnectionNotAdmitted,
  ConnectionRevokedError,
  ConnectionSlotCapExceeded,
  ConnectionSlotMismatch,
  ConnectionWriteRuleViolation,
  defaultAdmissionGate,
  openUserDb,
  USERDB_ERROR_CODES,
  UserDbError,
  type ConnectionAdmissionGate,
  type ConnectionAdmissionResult,
  type AppDocRecord,
  type AppMigrationRecord,
  type AppPersistErrorEvent,
  type AppRecord,
  type AppVersionMeta,
  type SaveAppVersionOptions,
  type ChatMessage,
  type ChatThread,
  type ConnectionRow,
  type InstallAppInput,
  type OpenUserDbOptions,
  type OpenUserDbResult,
  type UserDb,
  type UserDbErrorCode,
  type UserDbImportReport,
  // TASK-20260811 (ADR-0019 D7): the scratch executor's shapes — the data lane's tools
  // consume these, so they are part of the package's surface, not internal detail.
  type ScratchRunResult,
  type ScratchStatement,
  type ScratchStatementResult,
  // TASK-20261010-host-broker PR-2 (D-PR2-9): another app's materialised rows as plain tables
  // in the scratch copy — the chat door's `data_query` attaches them.
  type ScratchAttachTable,
  // TASK-20261010-cross-app-access AC7: the source side of the consent sheet.
  type AppDataColumn,
  type AppDataTable,
  type DescribeAppDataResult,
  MAX_QUERY_RESULT_BYTES,
  MAX_QUERY_ROWS,
} from './userdb/userdb.js';

export {
  AUTH_CONNECTION_FIELD,
  AUTH_FLOW_SECRET_PREFIX,
  AUTH_STATE_HMAC_SECRET_KEY,
  authAppSecretPrefix,
  authConnectionCredentialSecretKey,
  authConnectionSecretKey,
  authConnectionSlotPrefix,
  authConnectionStateSecretKey,
  authCredentialSecretKey,
  authFlowSecretKey,
  isAuthSecretKey,
  isLegacyAppSecretKey,
} from './userdb/auth-secrets.js';

export {
  APP_MODEL_SETTING_PREFIX,
  APP_PROVIDER_SETTING_PREFIX,
  APP_RENAMED_SETTING_PREFIX,
  STARTER_VERSION_SETTING_PREFIX,
  appIdFromModelSettingKey,
  appIdFromProviderSettingKey,
  appIdFromRenamedSettingKey,
  appIdFromStarterVersionSettingKey,
  appModelSettingKey,
  appProviderSettingKey,
  appRenamedSettingKey,
  starterVersionSettingKey,
  SHARED_APP_SETTING_PREFIX,
  SHARED_BUNDLE_SETTING_PREFIX,
  SHARE_LINK_SETTING_PREFIX,
  appIdFromSharedBundleSettingKey,
  bundleIdFromSharedAppSettingKey,
  shareLinkSettingKey,
  shareLinkSettingPrefixFor,
  sharedAppSettingKey,
  sharedBundleSettingKey,
  AGENT_DISMISSED_SETTING_PREFIX,
  agentDismissedSettingKey,
  lineageFromAgentDismissedSettingKey,
  // Scheduled tasks (TASK-20261009-scheduling-framework, ADR-0074 §2): the five
  // namespaces the scheduler keeps in `snug_settings`, single-homed like the rest.
  SCHEDULE_SETTING_PREFIX,
  SCHEDULE_RUNS_SETTING_PREFIX,
  SCHEDULER_STATE_SETTING_KEY,
  SCHEDULE_DECLINED_SETTING_PREFIX,
  SCHEDULE_MUTED_SETTING_PREFIX,
  appIdFromScheduleMutedSettingKey,
  scheduleDeclinedSettingKey,
  scheduleDeclinedSettingPrefixFor,
  scheduleMutedSettingKey,
  scheduleRunsSettingKey,
  scheduleSettingKey,
  taskIdFromScheduleRunsSettingKey,
  taskIdFromScheduleSettingKey,
  // Access between apps (TASK-20261010-cross-app-access, ADR-0075 §2, §7): the four
  // namespaces the access record keeps in `snug_settings`, single-homed like the rest.
  ACCESS_GRANT_SETTING_PREFIX,
  ACCESS_LOG_SETTING_PREFIX,
  ACCESS_DECLINED_SETTING_PREFIX,
  ACCESS_MUTED_SETTING_PREFIX,
  accessDeclinedSettingKey,
  accessDeclinedSettingPrefixFor,
  accessGrantSettingKey,
  accessLogSettingKey,
  accessMutedSettingKey,
  grantIdFromAccessGrantSettingKey,
  readerAppIdFromAccessMutedSettingKey,
  sourceAppIdFromAccessLogSettingKey,
} from './userdb/app-settings-keys.js';

// The import/export bound a `running`/`pending` claim is retired under (TASK-20261009 C4).
export { SCHEDULE_IMPORTED_CLAIM_MAX_AGE_MS } from './userdb/schedules.js';

// Access between apps (TASK-20261010-cross-app-access): the record types the accessors speak,
// and the PURE scoped read the access engine's Worker runs on its own sql.js instance (AC6) —
// and, since TASK-20261010-host-broker PR-2 (D-PR2-6), the PURE scoped dump the chat and
// scheduler doors materialise through the same Worker, with the one allow-list of declared
// column types a dump passes through.
export { type AccessDecline, type AccessImportReport } from './userdb/access.js';
export {
  DUMP_TYPE_ALLOW,
  scopedScratchDump,
  scopedScratchRead,
  type ScopedDumpCaps,
  type ScopedDumpResult,
  type ScopedDumpTable,
  type ScopedReadCaps,
  type ScopedReadDrift,
  type ScopedReadResult,
  type ScopedReadScope,
  type ScopedReadStatement,
} from './scoped-read.js';

// App sharing (TASK-20260904, ADR-0063): build / install / update one app as a bundle, and
// the first-bytes sniff that tells a bundle from a user file.
export {
  AGENT_INSTALL_SOURCE_PREFIX,
  SHARE_INSTALL_SOURCE_PREFIX,
  STARTER_INSTALL_SOURCE_PREFIX,
  agentInstallSource,
  buildAppBundle,
  declareSharedConnections,
  installAppFromBundle,
  isEditedCopy,
  seedDocsAbsentOnly,
  shareInstallSource,
  sniffSnugFile,
  stripRequirementForShare,
  updateAppFromBundle,
  type AppBundleInstallOptions,
  type AppBundleInstallResult,
  type AppBundleUpdateResult,
  type BuildAppBundleOptions,
  type BundleProvenance,
  type RefusedSlot,
  type SnugFileKind,
} from './userdb/app-bundle.js';

// The artifact export wrapper (TASK-20260905-binding-a-artifacts AC6, ADR-0065 §5): a user
// file as `snug-user.snug.json`, sniffed by prefix, verified by sha AND re-sniffed on the way in.
export {
  USER_FILE_WRAPPER_FILE_NAME,
  USER_FILE_WRAPPER_FORMAT,
  USER_FILE_WRAPPER_MAX_BYTES,
  USER_FILE_WRAPPER_PREFIX,
  unwrapUserFile,
  wrapUserFile,
  type UserFileUnwrap,
} from './userdb/user-file-wrapper.js';

export { SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY } from './userdb/sidecar-identity-keys.js';
export {
  CONTAINER_MAGIC,
  KDF_ITERATIONS,
  decryptContainer,
  encryptContainer,
  generateRecoveryKey,
  isEncryptedContainer,
  openFileKey,
  resealContainer,
  rewrapPassphrase,
  type DecryptResult,
  type RewrapResult,
  type Secrets as ContainerSecrets,
} from './crypto/container.js';

export {
  acquireUserDbWriterLock,
  createUserDbChannel,
  USERDB_LOCK_NAME,
  type AcquireUserDbWriterLockOptions,
  type CreateUserDbChannelOptions,
  type UserDbInvalidationChannel,
  type UserDbWriterLock,
} from './userdb/locks.js';

export {
  defaultFetch,
  fetchOrNetworkError,
  SYNC_ERROR_CODES,
  SyncProviderError,
  type FetchLike,
  type SyncErrorCode,
  type SyncProvider,
  type SyncProviderInfo,
  type SyncPullResult,
  type SyncPushResult,
} from './sync/provider.js';

export {
  loadSidecar,
  saveSidecar,
  sha256Hex,
  adoptLegacySidecar,
  sidecarFileFor,
  type SyncSidecarState,
} from './sync/sidecar.js';

export {
  createSyncLoop,
  type CreateSyncLoopOptions,
  type SyncableUserDb,
  type SyncEvent,
  type SyncLoop,
} from './sync/loop.js';

export {
  restoreFromOrigin,
  type RestorableUserDb,
  type RestoreFromOriginOptions,
  type RestoreFromOriginResult,
} from './sync/recovery.js';

export { createHubOriginProvider, type CreateHubOriginProviderOptions } from './sync/hub-origin.js';

export {
  buildDropboxAuthUrl,
  createDropboxProvider,
  DROPBOX_DEFAULT_PATH,
  exchangeDropboxCode,
  type BuildDropboxAuthUrlOptions,
  type CreateDropboxProviderOptions,
  type DropboxTokenResponse,
  type ExchangeDropboxCodeOptions,
} from './sync/dropbox.js';

export { base64ToBytes, bytesToBase64 } from './base64.js';

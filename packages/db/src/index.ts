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
  type CreateDbDriverOptions,
  type DbDriverResult,
  type DbPersistence,
  type DbRecoverableErrorEvent,
  type SnugDbDriver,
} from './driver.js';

export { DB_ERROR_CODES, type DbErrorCode } from './errors.js';

export {
  createIdbBackend,
  createMemoryBackend,
  createOpfsBackend,
  detectPersistenceBackend,
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
} from './userdb/app-settings-keys.js';

// App sharing (TASK-20260904, ADR-0063): build / install / update one app as a bundle, and
// the first-bytes sniff that tells a bundle from a user file.
export {
  SHARE_INSTALL_SOURCE_PREFIX,
  buildAppBundle,
  declareSharedConnections,
  installAppFromBundle,
  seedDocsAbsentOnly,
  shareInstallSource,
  sniffSnugFile,
  stripRequirementForShare,
  updateAppFromBundle,
  type AppBundleInstallOptions,
  type AppBundleInstallResult,
  type AppBundleUpdateResult,
  type BuildAppBundleOptions,
  type RefusedSlot,
  type SnugFileKind,
} from './userdb/app-bundle.js';

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

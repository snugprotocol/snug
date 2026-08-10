// @snugprotocol/db — the per-app database: sql.js (WASM SQLite) behind the runner's
// DbDriver seam, one isolated database per host-assigned namespace, kv in `snug_kv`,
// OPFS → IndexedDB → memory persistence with debounced write-back, and real `.sqlite`
// export/import (5 MiB artifact cap, 8 MiB db frame class). Browser-safe: no node: imports.

export {
  createDbDriver,
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

export { namespaceToFileName } from './namespace.js';

export {
  ConnectionRevokedError,
  ConnectionSlotCapExceeded,
  ConnectionWriteRuleViolation,
  HostFreezeViolation,
  openUserDb,
  USERDB_ERROR_CODES,
  UserDbError,
  type AppDocRecord,
  type AppMigrationRecord,
  type AppPersistErrorEvent,
  type AppRecord,
  type AppVersionMeta,
  type AuthSpecRow,
  type ChatMessage,
  type ChatThread,
  type ConnectionRow,
  type InstallAppInput,
  type OpenUserDbOptions,
  type OpenUserDbResult,
  type UserDb,
  type UserDbErrorCode,
  type UserDbImportReport,
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

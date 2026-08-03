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
  openUserDb,
  USERDB_ERROR_CODES,
  UserDbError,
  type AppRecord,
  type AppVersionMeta,
  type ChatMessage,
  type ChatThread,
  type InstallAppInput,
  type OpenUserDbOptions,
  type OpenUserDbResult,
  type UserDb,
  type UserDbErrorCode,
} from './userdb/userdb.js';

export {
  acquireUserDbWriterLock,
  createUserDbChannel,
  USERDB_LOCK_NAME,
  type AcquireUserDbWriterLockOptions,
  type CreateUserDbChannelOptions,
  type UserDbInvalidationChannel,
  type UserDbWriterLock,
} from './userdb/locks.js';

export { base64ToBytes, bytesToBase64 } from './base64.js';

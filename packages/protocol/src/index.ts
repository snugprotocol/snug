// @snugprotocol/protocol — the Snug envelope protocol: zod schemas, typed helpers,
// and the single home of every wire constant. Source of truth for snugprotocol/spec
// (see docs/engineering/SPEC_SYNC.md). Browser-safe; runtime dependency: zod only.

export {
  CDN_ALLOWLIST,
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  SNUG_APP_REQUEST_TAG,
  STRIP_HEADERS,
  classifyErrorCode,
  isKnownErrorCode,
  type FrameType,
  type KnownErrorCode,
} from './constants.js';

export {
  APP_KV_TABLE,
  APP_OBJECT_NAME_RULE,
  APP_RESERVED_PREFIXES,
  APP_REST_PREFIX,
  APP_REST_SEPARATOR,
  STANDARD_APP_DOC_SLUGS,
  USERDB_DDL,
  USERDB_FILE,
  USERDB_INDEX_DDL,
  USERDB_LIMITS,
  USERDB_OPFS_DIR,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
  appDataToken,
  appRestTableName,
  isValidAppObjectName,
  type AppSchemaJson,
  type AppSchemaObject,
  type UserDbTable,
} from './userdb-schema.js';

export {
  appAnnounceSchema,
  appCancelSchema,
  appEventSchema,
  appMessageSchema,
  appResponseSchema,
  createResponder,
  dbRequestSchema,
  dbResponseSchema,
  frameWithinLimits,
  hostEventSchema,
  hostReadySchema,
  parseFrame,
  respondTo,
  responseErrorSchema,
  type AppAnnounceFrame,
  type AppCancelFrame,
  type AppEventFrame,
  type AppMessageFrame,
  type AppResponseFrame,
  type DbRequestFrame,
  type DbResponseFrame,
  type Frame,
  type FrameParseResult,
  type HostEventFrame,
  type HostReadyFrame,
  type Responder,
  type ResponseError,
} from './frames.js';

export {
  appRequestEnvelopeSchema,
  buildAppRequest,
  isAppRequest,
  parseAppRequest,
  type AppRequestEnvelope,
  type AppRequestParseResult,
  type EnvelopeInput,
} from './envelope.js';

export { parseAgentReply, type AgentReplyResult } from './reply.js';

export {
  scanForCredentialValues,
  stripCredentialHeaders,
  type CredentialFinding,
  type CredentialScan,
} from './security.js';

export { buildJsonSchemas } from './json-schemas.js';

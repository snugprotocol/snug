/**
 * Minimal db-request frame builders for playground tests.
 *
 * The db package has its own copies (`packages/db/src/__tests__/helpers.ts`) but they are
 * not exported across the package boundary, and importing a package's test helpers would
 * couple two test suites through a path that neither package promises to keep.
 */

import { FRAME_TYPES, PROTOCOL_VERSION, type DbRequestFrame } from '@snugprotocol/protocol';

let seq = 0;

const base = () => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.dbRequest,
  requestId: `t-${++seq}`,
  instanceId: 'ins-test',
});

export const execFrame = (sql: string, params?: unknown[]): DbRequestFrame => ({
  ...base(),
  op: 'exec',
  sql,
  ...(params !== undefined ? { params } : {}),
});

export const exportFrame = (): DbRequestFrame => ({ ...base(), op: 'export' });

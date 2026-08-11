/**
 * Minimal db-request frame builders for playground tests.
 *
 * The db package has its own copies (`packages/db/src/__tests__/helpers.ts`) but they are
 * not exported across the package boundary, and importing a package's test helpers would
 * couple two test suites through a path that neither package promises to keep.
 */

import type { DbRequestFrame } from '@snugprotocol/protocol';

let seq = 0;

const base = (): Pick<DbRequestFrame, 'v' | 'type' | 'id'> => ({
  v: 1,
  type: 'db-request',
  id: `t-${++seq}`,
});

export const execFrame = (sql: string, params?: unknown[]): DbRequestFrame => ({
  ...base(),
  op: 'exec',
  sql,
  ...(params !== undefined ? { params } : {}),
} as DbRequestFrame);

export const exportFrame = (): DbRequestFrame => ({ ...base(), op: 'export' }) as DbRequestFrame;

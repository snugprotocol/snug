// exportDb.ts — the ownership moment: a real `.sqlite` file, downloaded. Calls the
// db driver's export op DIRECTLY (host-side; no synthetic frame ever enters the
// sandbox) and wraps the bytes in a Blob download.

import { base64ToBytes } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION, type DbRequestFrame } from '@snugprotocol/protocol';
import type { DbDriver } from '@snugprotocol/runner';

export type ExportResult = { ok: true; blob: Blob } | { ok: false; message: string };

let exportSeq = 0;

export async function exportDatabase(driver: DbDriver, namespace: string): Promise<ExportResult> {
  const frame: DbRequestFrame = {
    v: PROTOCOL_VERSION,
    type: FRAME_TYPES.dbRequest,
    requestId: `host-export-${++exportSeq}`,
    instanceId: 'host-export',
    op: 'export',
  };
  const result = await driver.handle(namespace, frame);
  if (!result.ok) return { ok: false, message: result.message };
  const bytesBase64 = result.bytesBase64;
  if (bytesBase64 === undefined) return { ok: false, message: 'export returned no bytes' };
  const bytes = base64ToBytes(bytesBase64); // total decoder: undefined on malformed input
  if (bytes === undefined) return { ok: false, message: 'export bytes were not valid base64' };
  // Copy into a fresh ArrayBuffer-backed view — BlobPart rejects ArrayBufferLike views.
  return { ok: true, blob: new Blob([new Uint8Array(bytes)], { type: 'application/x-sqlite3' }) };
}

/** Kick off a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

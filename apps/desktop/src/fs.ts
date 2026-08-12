// FileBackendFs over the shell's user-file commands (AC2).
//
// Contract (packages/db createFileBackend): readFile resolves undefined ONLY
// for genuine absence — the Rust side encodes that as a one-byte discriminant
// (0 = absent, 1 = present + bytes) so an empty file can never masquerade as
// "not found" (and vice versa). writeFileAtomic is temp+fsync+rename in Rust.

import type { FileBackendFs } from '@snugprotocol/db';
import { invoke } from '@tauri-apps/api/core';

export function createTauriFileFs(): FileBackendFs {
  return {
    async readFile(path: string): Promise<Uint8Array | undefined> {
      const raw = await invoke<ArrayBuffer>('read_user_file', { name: path });
      const bytes = new Uint8Array(raw);
      if (bytes.length === 0) throw new Error('read_user_file returned no discriminant');
      if (bytes[0] === 0) return undefined;
      return bytes.slice(1);
    },
    async writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
      await invoke('write_user_file', bytes, { headers: { name: path } });
    },
  };
}

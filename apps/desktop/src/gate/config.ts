// Shell-gate config accessor (TASK-20260812 P4). One invoke, cached forever.
//
// In a RELEASE shell the `shell_gate_config` command does not exist (gate.rs is
// `#[cfg(debug_assertions)]`), so the invoke rejects and this resolves null —
// which is also the answer in a debug shell without SNUG_SHELL_GATE=1. The
// normal boot path treats null as "no gate" and proceeds untouched.

import { invoke } from '@tauri-apps/api/core';

export interface ShellGateConfig {
  outPath: string;
  /** Journey host → replacement origin (e.g. "http://127.0.0.1:43120"). */
  remap: Record<string, string>;
}

let read = false;
let cached: ShellGateConfig | null = null;

export async function getShellGateConfig(): Promise<ShellGateConfig | null> {
  if (read) return cached;
  read = true;
  try {
    const config = await invoke<ShellGateConfig | null>('shell_gate_config');
    cached = config ?? null;
  } catch {
    // Command absent (release build) or IPC unavailable — both mean "no gate".
    cached = null;
  }
  return cached;
}

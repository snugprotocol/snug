/**
 * The shell half of the sidecar seam (ADR-0032) — thin wrappers over the two Rust commands.
 *
 * Deliberately thin. Every guard lives in Rust (`sidecar.rs::admit_app_request`), because the
 * TS caller is not the last word on what the shell will dial — the `lan_fetch` precedent.
 * Nothing here re-checks a route or a path: a second opinion in TypeScript would be a second
 * thing to keep in sync, and the one that matters is the one running before `connect()`.
 *
 * Note what these functions do NOT accept: a socket path, a host, or a port. The Rust side
 * names the socket, so no caller in the webview can point the transport somewhere else.
 */

import { invoke } from '@tauri-apps/api/core';

export interface SidecarStatus {
  running: boolean;
  /** Present while running — the wizard's pairing routes require it. */
  nonce?: string;
}

export interface SidecarHttpResponse {
  status: number;
  body: string;
}

/**
 * Start, stop, report — or FORGET the WhatsApp helper (TASK-20260821 AC5).
 * `forget` stops the helper and removes the on-disk session store; it is the deep
 * delete's disk backstop for the case where the helper cannot run at all.
 */
export async function sidecarCtl(action: 'start' | 'stop' | 'status' | 'forget'): Promise<SidecarStatus> {
  return invoke<SidecarStatus>('sidecar_ctl', { action });
}

/**
 * Call the helper as an APP. Rust refuses every route outside the app-reachable contract —
 * including every pairing route — before a socket is opened.
 */
export async function sidecarFetch(
  method: string,
  pathAndQuery: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<SidecarHttpResponse> {
  return invoke<SidecarHttpResponse>('sidecar_fetch', {
    method,
    pathAndQuery,
    ...(body !== undefined ? { body } : {}),
    ...(headers !== undefined ? { headers } : {}),
  });
}

/**
 * Call the helper as the WIZARD: the same socket, plus the pairing routes an app may never
 * reach, with the spawn nonce attached on the Rust side.
 *
 * A separate command rather than a flag on `sidecarFetch`, because a flag would be a claim
 * the caller makes and an app can make any claim. Command identity is not forgeable from an
 * app iframe — capabilities are main-window scoped and the gate pins IPC unreachability per
 * command — so the boundary is structural.
 */
export async function sidecarWizardFetch(
  method: string,
  pathAndQuery: string,
  body?: string,
): Promise<SidecarHttpResponse> {
  return invoke<SidecarHttpResponse>('sidecar_wizard_fetch', {
    method,
    pathAndQuery,
    ...(body !== undefined ? { body } : {}),
  });
}

/** What the shell knows about a helper on disk vs the build's pin (ADR-0060 §3). */
export interface HelperStatus {
  name: string;
  installed: boolean;
  /** `absent` | `dev` | `downloaded` */
  kind: 'absent' | 'dev' | 'downloaded';
  installedVersion?: string;
  requiredVersion: string;
  /** Installed version ≠ pinned version (exact). Never blocks — the UI offers the update. */
  mismatch: boolean;
  arch: string;
  /** From the pin, so the consent card can state the size BEFORE any request. */
  downloadBytes: number;
  unpackedBytes: number;
  /** A linked session is on disk, so the shell wants this helper at launch. */
  linkedSessionOnDisk: boolean;
}

export interface HelperInstallProgress {
  name: string;
  phase: 'downloading' | 'verifying' | 'installing' | 'starting' | 'done';
  received: number;
  total: number;
}

export async function helperStatus(name: string): Promise<HelperStatus> {
  return invoke<HelperStatus>('helper_status', { name });
}

/**
 * Download → verify → install → start (ADR-0060). Only ever called from a user click.
 * Progress rides a Tauri event; the listener is detached when the invoke settles.
 */
export async function helperInstall(
  name: string,
  onProgress?: (p: HelperInstallProgress) => void,
): Promise<HelperStatus> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten =
    onProgress === undefined
      ? undefined
      : await listen<HelperInstallProgress>('snug:helper-install', (e) => {
          if (e.payload.name === name) onProgress(e.payload);
        });
  try {
    return await invoke<HelperStatus>('helper_install', { name });
  } finally {
    unlisten?.();
  }
}

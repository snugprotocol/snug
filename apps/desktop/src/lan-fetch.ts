// The webview half of the pinned-TLS LAN transport (ADR-0023 Decision 3; P0
// amendment 6). Turns the executor's `lanFetch(url, init, pin)` call into an
// invoke of the Rust `lan_fetch` command, and its JSON answer back into a
// `Response` the executor's gate 9/10 can read exactly as they read a fetch.
//
// WHAT THIS FILE MUST NOT DO, stated up front because each is a one-line
// temptation:
//
//   * It must not decide anything. Host class, redirect policy, and the size
//     cap are enforced in RUST (src-tauri/src/lanfetch.rs), before a socket is
//     opened and before bytes cross IPC. Re-deciding here would create a second
//     guard that can disagree with the first — and the one in the webview is
//     the one an attacker who has the webview does not have to satisfy.
//   * It must not swallow a refusal into a `Response`. A Rust-side refusal is a
//     rejected promise, which is what the executor's `catch` around gate 9
//     expects; turning it into a synthetic 4xx would make a refusal look like
//     the DEVICE said no.
//   * It must not carry a `danger`/accept-invalid flag anywhere. There isn't
//     one to carry: the trust decision is the pin, evaluated inside a rustls
//     verifier (lessons.md 2026-08-12 — a guard expressed as a FLAG is only as
//     real as the transport's willingness to read it).

import { invoke } from '@tauri-apps/api/core';

/** What the Rust command answers with. `pin` rides back in pair mode only. */
interface LanFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  pin?: { fingerprint: string; cn: string };
}

/**
 * Normalize the executor's `HeadersInit` to the plain record the command takes.
 * The executor always passes a plain object today; the other two shapes are
 * handled because a silent drop of injected headers would be a credential that
 * never arrives and a 401 nobody can explain.
 */
function toRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, name) => void (out[name] = value));
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

/**
 * The executor-facing seam. `pin` is REQUIRED — see `SnugPlatform.lanFetch`:
 * a pinless call is pair mode, which only the wizard's pairing step may make.
 */
export async function lanFetch(url: string, init: RequestInit, pin: string): Promise<Response> {
  const result = await invoke<LanFetchResponse>('lan_fetch', {
    url,
    method: typeof init.method === 'string' ? init.method : 'GET',
    mode: 'pinned',
    pin,
    headers: toRecord(init.headers),
    ...(typeof init.body === 'string' ? { body: init.body } : {}),
  });
  // A 30x comes back INTACT for the executor's gate 9 to refuse. Rust installs
  // `Policy::none()`, so a redirect is a status, never a followed hop — and the
  // executor is the seat that decides what a status means, here as everywhere.
  return new Response(result.body, { status: result.status, headers: result.headers });
}

/**
 * PAIR MODE — the wizard's one-time credential exchange (ADR-0023 D2). Accepts
 * and CAPTURES the device's certificate, returning the pin beside the response
 * so the wizard writes pin + minted key in a single step.
 *
 * Separate from `lanFetch` rather than a mode parameter on it, deliberately: the
 * two have different trust semantics, and a shared entry point with a mode
 * argument is one mistyped string away from turning every request into a
 * trust-anything call. The Rust side rejects an unknown mode outright for the
 * same reason.
 *
 * EXPORTED FOR THE WIZARD, which is the only legitimate caller — pairing
 * happens after the user approves the row and presses a physical button on the
 * device. It is not part of `SnugPlatform.lanFetch` and the executor cannot
 * reach it.
 */
export async function lanPair(
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string; pin?: { fingerprint: string; cn: string } }> {
  const result = await invoke<LanFetchResponse>('lan_fetch', {
    url,
    method: init.method,
    mode: 'pair',
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return {
    status: result.status,
    body: result.body,
    ...(result.pin !== undefined ? { pin: result.pin } : {}),
  };
}

// sidecarForget.ts — the helper-side half of the Telepath deep delete (TASK-20260821 AC5).
//
// The user-DB cascade erases everything INSIDE the file; this erases everything the
// WhatsApp feature left OUTSIDE it: the helper's session keys, its minted access token,
// and the durable thread cache under ~/Snug. Owner decision 2026-08-21: deleting the last
// sidecar app is a FULL device unlink — the phone shows the companion device removed, and
// a reinstall starts from a fresh QR scan.
//
// Best-effort BY DESIGN, in two independent stages, because the failure modes differ:
//
//   1. helper start → POST /session/forget — the only path that can tell WHATSAPP about
//      the unlink (a Baileys logout needs a live, credentialed session). If the helper
//      cannot start (missing install, old node), this stage is skipped: the phone keeps
//      showing a dead companion entry until the user removes it there. Recorded residual.
//   2. sidecarCtl('forget') — the DISK backstop: stop the helper, then Rust removes the
//      session store directory. This one is what "deleted" ultimately means, and it runs
//      whether or not stage 1 worked.
//
// Neither stage may ever fail the app delete that triggered it — the cascade has already
// committed, and a dead helper must not resurrect a half-deleted app flow.

import { getPlatform } from '../platform/platform.js';

export async function forgetSidecarSession(): Promise<void> {
  const { sidecarCtl, sidecarWizardFetch } = getPlatform();
  // Web has neither seam AND nothing on disk — a browser tab never spawned a helper.
  if (sidecarCtl === undefined || sidecarWizardFetch === undefined) return;
  try {
    // Idempotent by construction: a running helper answers with its existing nonce.
    await sidecarCtl('start');
    await sidecarWizardFetch('POST', '/session/forget');
  } catch (err) {
    console.warn('telepath deep delete: the helper-side unlink failed — the disk backstop still runs', err);
  }
  try {
    await sidecarCtl('forget');
  } catch (err) {
    console.warn('telepath deep delete: removing the WhatsApp session store failed', err);
  }
}

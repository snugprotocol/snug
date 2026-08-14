# 0025 — LAN pairing verifies before it claims; LAN rows never route through the api-key screens

- **Status:** proposed (drafted at Gate 2 of TASK-20260814-hue-pairing-e2e; accepted when the owner approves that plan)
- **Date:** 2026-08-14
- **Task:** TASK-20260814-hue-pairing-e2e

## Context

The owner's first hardware test of the ADR-0023 Hue lane surfaced a truthfulness gap
rather than a transport defect:

- `runLanPairing` claims "connected" on the pairing response alone. The claim is
  instant (a LAN round-trip is tens of milliseconds), nothing ever exercises the minted
  key until an app does, and the one shipped LAN starter can never exercise it (the
  app-addressing runtime gap — apps cannot name the bridge host). A successful pairing
  is therefore **indistinguishable from a failed one** from the user's chair.
- ADR-0023 deliberately omitted a `testRequest` for hue ("every CLIP v2 read requires
  the key the pairing step mints, so a probe before pairing can only fail... pairing IS
  the verification"). That reasoning covered the PRE-pair probe only; it left the
  POST-pair claim unproven.
- The wizard's step machine (`nextStep`) knows nothing about LAN rows; the
  `lanNeedsPairing` interceptor hides the register/credentials screens only while the
  minted key is ABSENT. Reopening a PAIRED row therefore re-walks
  review → register ("press the link button" again) → credentials (an empty,
  un-fillable secret box — C1 never renders a stored secret) → done. The owner read
  that ghost flow, reasonably, as "it never pulled the key."

## Decision

1. **A pairing exchange carries a required `verify` seat**
   (`WellKnownPairingExchange.verify: { method: 'GET', pathAndQuery }`, registry data,
   human-reviewed like every other seat). After the key+pin write, the wizard fires the
   verify read through the PINNED transport (`platform.lanFetch`) with the just-captured
   pin, injecting the entry's own `request.headerTemplate` with only the just-minted
   `secretField` value. Only a 2xx sets connection state `connected` and lands the done
   screen. Hue verifies with `GET /clip/v2/resource/bridge`. `verify` is REQUIRED: a
   pairing provider that cannot be verified post-mint re-creates this defect.
2. **Verify failure keeps the mint, not the claim.** Key+pin stay stored (the device did
   mint them; re-pairing simply overwrites), connection state stays unconnected, and the
   user gets a fixed-sentence explanation distinguishing "could not reach the device for
   the check" from "the device refused the minted key". C1 unchanged: the probe response
   is read for its status only — never stored, rendered, or quoted.
3. **"Pairing owed" derives from the verified fact, not key presence.** The wizard's
   gate reads connection state `status === 'connected'` — the same fact the executor
   honors — so a key-present-but-unverified row lands back on the pair screen, and the
   component layer stops enumerating secret keys.
4. **LAN rows never route through `register`/`credentials`.** `nextStep('review', lanReq)`
   goes to `done` (the pairing interceptor and done screen own everything after review);
   the state transitions for those screens refuse LAN rows outright. The registry's
   walkthrough instructions still render — on the host-collection screen, where they
   always have.

## Consequences

- The wizard can no longer lie in either direction: no "connected" without a verified
  credentialed read, and no setup re-walk for a verified row.
- ADR-0023's "no testRequest" stance is AMENDED, not reversed: still no pre-pair probe,
  and the omission of a user-facing "test connection" button stands; verification is a
  mandatory internal step of the pairing act itself.
- Future pairing providers must ship a verify read (registry review enforces it by
  type), and the verify lane exercises exactly the executor's pinned path — so a
  verified pairing also proves the transport an app will later use.
- The starter app's copy stops claiming pairing lives elsewhere; making apps actually
  reach the bridge (the addressing seat) remains open and is explicitly NOT decided
  here.

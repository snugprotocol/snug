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
   human-reviewed like every other seat). **Verify first, then ONE durable write per
   outcome** (tightened at Gate 5's review): the verify read fires through the PINNED
   transport (`platform.lanFetch`) with the just-captured pin as an IN-MEMORY argument,
   injecting the entry's own `request.headerTemplate` (via the auth package's one
   template renderer) with only the just-minted `secretField` value — and a render that
   does not actually carry the minted value refuses rather than degrading into a
   liveness probe any 2xx would satisfy. Nothing durable lands before the verdict, so
   the executor's pin-gated LAN lane cannot serve app traffic with an unproven key
   during the round trip, and a crash mid-verify leaves no trace ("unverified ⇒
   re-pair" is the recovery either way). A 2xx writes key + pin +
   `{ status: 'connected', lanVerifiedAt }` together and lands the done screen —
   `lanVerifiedAt` is written by the verify step and nothing else. Hue verifies with
   `GET /clip/v2/resource/bridge`. `verify` is REQUIRED: a pairing provider that cannot
   be verified post-mint re-creates this defect.
2. **Verify failure keeps the mint, not the claim.** The failure outcome's one write is
   key + pin + `{ status: 'pending' }` (the device did mint them; re-pairing simply
   overwrites), and the user gets a fixed-sentence explanation distinguishing "could
   not reach the device for the check" from "the device refused the minted key" — held
   in a store rather than screen state, because the failure bump remounts the pairing
   screen and a local error would be eaten by exactly that remount. Every outcome bumps
   the revision: a durable state change always announces itself. No `lastError` is
   written — the `_connection` KV syncs and exports, and a verify failure is a
   wizard-screen fact, not a durable one. C1 unchanged: the probe response is read for
   its STATUS only — the body is never read, stored, rendered, or quoted.
3. **"Pairing owed" derives from the verified fact, through one reader.** A LAN row is
   verified iff `status === 'connected'` AND `lanVerifiedAt` is present; one state-layer
   derivation is the only reader of the connection state, and the wizard sheet holds
   only its boolean. A key-present-but-unverified row lands back on the pair screen; a
   PRE-FIX row (`connected` written by the old code, no marker) is likewise
   pairing-owed — the honest treatment of a claim nothing ever proved, and the reason no
   data migration is needed. **Accepted divergence:** the connected-fetch executor's LAN
   gate (9a) continues to key on pin presence, deliberately — a limbo row's app requests
   fail at the device and route back through the NET_AUTH_FAILED repair CTA into this
   wizard. Extending gate 9a to consult status was considered and rejected: it would
   plant a second truth source in the executor for a failure mode that is already
   self-limiting.
4. **LAN rows never route through `register`/`credentials`.** `nextStep('review', lanReq)`
   goes to `done` (the pairing interceptor and done screen own everything after review);
   the state transitions for those screens refuse LAN rows outright. The registry's
   walkthrough instructions still render — on the host-collection screen, where they
   always have.
5. **What was verified is invalidated when what it was verified against changes.** A
   re-approval that moves a LAN ceiling, changes the field set, or moves the row INTO
   or OUT OF the LAN class (`before || after` — keying on the destination alone let a
   LAN→non-LAN rebind strand the mint and the proof, resurrectable on a later rebind
   back) downgrades the connection state to `{ status: 'pending' }` (dropping pin and
   marker) and deletes the pairing-owned secret: a key minted by one device must not
   ride a ceiling now pointing at another, and "verified with the device at <host>"
   must never name a host it was not proven against. The ceiling comparison is
   order-insensitive and shared with the drift migration's — a destructive downgrade
   must not depend on a sort it does not own. Host-identical, field-identical
   re-approvals keep the verified state.
6. **The sheet cannot render ahead of the facts.** The wizard sheet refuses to render a
   step for a revision whose row it has not re-read (it tracks the loaded revision and
   shows the loading hint on mismatch), and its final fallback renders the done screen
   for a LAN row only when the verified fact holds — so the transient
   approve-then-re-read window can never flash a success claim, which is the exact lie
   this ADR exists to kill arriving as a race instead of a route.

## Consequences

- The wizard can no longer lie in either direction: no "connected" without a verified
  credentialed read, and no setup re-walk for a verified row.
- ADR-0023's "no testRequest" stance is AMENDED, not reversed: still no pre-pair probe,
  and the omission of a user-facing "test connection" button stands; verification is a
  mandatory internal step of the pairing act itself.
- Future pairing providers must ship a verify read (registry review enforces it by
  type), and the verify lane rides the same pinned TRANSPORT the executor's LAN lane
  uses — so a verified pairing also proves the transport an app will later use. It is
  NOT the executor path (no gates 1–8, no scrub): a deliberate, contained second
  network call, kept safe by construction — host only from the frozen ceiling,
  path/method only from the registry, header via the shared template renderer, response
  read for status alone. Recorded here so it is not mistaken for the "small dedicated
  fetch" anti-pattern the test-connection probe documents.
- The starter app's copy stops claiming pairing lives elsewhere; making apps actually
  reach the bridge (the addressing seat) remains open and is explicitly NOT decided
  here.

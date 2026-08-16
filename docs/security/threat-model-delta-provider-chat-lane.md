# Threat-model delta — provider chat lane (TASK-20260815-provider-chat-lane, ADR-0031)

What this change ADDED to the attack surface, what guards it, and what is **accepted and
not mitigated**. Baseline: ADR-0019's data-lane delta and the AL-03/AL-04 connected-fetch
deltas — the executor and its ten gates are UNCHANGED by this task.

## New surface

An LLM turn (byok/local app-chat, provider lane) can now COMPOSE HTTP requests that the
host executes with injected credentials, via `provider_request` →
`connectedFetchDepsFor` → `createConnectedFetch`. The model chooses method, URL (within
the frozen ceiling), headers (credential-shaped ones stripped), and body.

## Guards carried, per link

- **Grant boundary unchanged:** zero approved rows → `NET_NOT_APPROVED`; the pending
  seat is never read; no runtime widening path exists (ADR-0016 stands). The lane's
  context assembler (`providerContext.ts`) renders APPROVED rows only — declared and
  revoked rows are absent by test.
- **C1:** the lane context never touches `snug_secrets`; the tool result is the
  executor's gate-10-scrubbed delivery; credential-shaped request headers are stripped
  before injection (gate 7). Hostile-fixture tests pin a `+`/`=`/space credential absent
  from every LLM-bound string.
- **Private network facts (ADR-0026 §3):** `publicHosts` filters RFC-1918
  unconditionally; LAN rows teach symbolic addressing only; and the RENDERED tool result
  scrubs every RFC-1918 IPv4 literal (raw octets survive all JSON/URL encodings
  verbatim) — the executor's body scrub deliberately does not do this for app-bound
  delivery, so the chat renderer owns it (plan-review F1).
- **Writes:** the executor's confirm gate parks BEFORE any credential read; a turn
  aborted with a parked confirm DENIES it (no post-abort execution); parked confirms are
  a FIFO queue so no resolver is orphaned; the dialog mounts at the app shell so every
  chat surface renders it.
- **Retry containment:** per-turn `provider_request` cap (default 6); refusal results
  instruct the model not to retry; failures surface code-keyed only (N1), with the M12
  filter (blocked/denied codes get no connect CTA).

## Accepted residuals (stated, not mitigated)

1. **Confused-deputy prompt injection.** Provider response bodies and stored rows are
   untrusted input to a turn that (on `provider_write`) holds a write-capable tool.
   Contained by: defanged `<api_result>` blocks with the data-not-instructions tail, the
   user confirm on every mutating call, and the call cap. A hostile provider response
   can still SUGGEST a write the user then approves — the confirm dialog naming host,
   method and URL is the wall. (ADR-0031 residual; revisit at AL-11 threat-model v1.)
2. **Shared session-remember scope (plan-review F5, ACCEPTED).** The remember key is
   (app, host, method) with no surface dimension: a remembered grant from the app's own
   baked-in write pre-authorizes chat-composed writes to that host+method, and vice
   versa. One gate, one meaning — pinned by test (AC13). A per-surface key is the
   revisit lever if real usage shows the scopes diverging.
3. **Provider bodies re-enter the classifier (plan-review F12).** The last two persisted
   exchanges feed the next message's intent classifier; a crafted provider body could
   try to steer the NEXT turn's routing. Contained by the 300-char defanged history cap
   and fail-closed clarify. Same class as ADR-0019's stored-rows residual.
4. **Scrub re-encoding boundary (A3 carry-over).** The credential-reflection scrub
   matches raw and percent-encoded forms; a provider echoing a credential under other
   encodings (base64 of the key, for instance) is delivered — same boundary as
   app-bound delivery, now with an LLM reader. Unchanged posture, restated here because
   the reader changed.
5. **Dialog copy attribution (plan-review F11, accepted for this child).** The confirm
   dialog says "this app is asking" for what is actually the user's own chat-composed
   request. Child B's confirm card fixes attribution; until then the host/method/URL
   facts on the dialog are correct and the actor label is imprecise.

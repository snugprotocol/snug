# whatsapp — "WhatsApp Twin": one thread, read closely, answered in your own voice

**Please read this first.** Linking an automation tool to a personal WhatsApp account is
**against WhatsApp's terms of service, and accounts have been banned for it.** Twin paces its
sends like a human and caps them, but that is harm reduction, not evasion, and it is not a
guarantee. Only link an account whose loss you would accept. This starter exists because the
protocol should be able to carry an app no gatekept store would ship — not because the risk
is small.

**Second thing worth knowing before you point it at a group.** The people in your threads
never agreed to any of this. Twin builds written profiles of them and, under BYOK, their
messages travel to whichever model provider you configured, under your own key. Twin
pseudonymises before every model turn — participants become `P1`, `P2`, phone numbers and
WhatsApp IDs are stripped — so what leaves is the conversation's shape, not its roster. The
"forget this thread" control deletes everything derived from a conversation. Both are
deliberate: the honest answer to "should this app exist" is "only with these".

**What it demos:** the first `linked_device` connection (ADR-0032) — a provider that
authenticates a *device*, not a request. The session lives in a helper process the desktop
shell spawns and supervises, reached over a unix socket by a purpose-built Rust command
rather than through the host ceiling, because a locally-spawned helper is a **capability, not
a host**. Plus the usual connected-starter seams: symbolic `snug-connection://` addressing
(ADR-0026), the provider chat lane, and an agent grounded in live data.

**What it does NOT do yet: unattended replies.** Twin drafts, you send. The host-side
approval gate that unattended sending requires is built and tested (ADR-0033's
`StandingApprovalGate` — scoped to one thread and one trigger, rate-capped, quiet-hours
aware, revocable), but an app cannot reach it: arming has to be a standing approval the
*host* records, and the frames an app may speak have no seat for that. Rather than ship a
switch that sets a boolean and authorizes nothing, this version says so on the surface and
offers manual Reply. Picking the arming surface is a follow-up (owner decision, 2026-08-17).

**Complement thesis:** WhatsApp's own app is for *having* the conversation — it is a great
messenger and Twin does not try to be one. Twin is for *understanding* one: who carries the
thread, who goes quiet when it gets tense, how you yourself write when you are in it. WhatsApp
will never ship a feature that profiles your friends and drafts in your voice, and it
shouldn't. That asymmetry is the point — this is the app you can only have because you own
the runtime.

**Connection posture:** slot `whatsapp`, kind `linked_device`. The registry entry pins the
helper's symbolic host, the pairing flow (start → QR → poll → verify-before-claim per
ADR-0025), and the header template that injects the minted helper token; this folder's
[`connection.json`](connection.json) declares the slot, the kind and the one secret field.
**Desktop only** — a unix socket is not reachable from a browser tab, and the shelf tile says
so rather than dead-ending. Your WhatsApp session keys never leave the helper's own disk
store: what Snug holds is a token *to the helper*, not a credential to WhatsApp. Every send —
manual or armed — traverses the connected-fetch mutating gate, and every unattended send is
written to the in-app activity journal.

**LLM posture:** agent-driven (ADR-0011). `RESPONSE_SCHEMA` is non-null and a `responseSchema`
travels with every `sendMessage`; the contract is in
[`runtime-contract.json`](runtime-contract.json). Four actions: `profile_thread`,
`answer_question`, `draft_reply`, `translate`. Every reply is validated locally before it
touches state — an off-script answer degrades to a visible "the model answered off-script"
notice and saves nothing, because a "profile" that silently half-parsed would be a confident
statement about a real person built from garbage. **The helper itself is LLM-free by
construction**: it holds no model key and makes no model call, so analysis, drafting and
translation all happen in the governed host. One consequence, stated plainly rather than
patched: auto-reply only runs while Snug is open. Giving the helper its own model key would
fix that and create a second brain outside every reviewed surface, so it stays as it is.

**App DB:** four tables. `threads` (which conversation was analysed, and when), `persona`
(one row per person plus the dynamics and your own voice profile, replaced on re-analysis
rather than accumulated), `translations` (per-message cache, keyed by thread + message +
language), and `activity` (the send journal). "Forget this thread" cascades all four.

**The export path is not a nice-to-have.** WhatsApp *pushes* history in chunks and sometimes
never confirms it finished — the sidecar reports `explicit: false` when completion was only
inferred, and Twin renders that as *partial*, never as "this is everything". Pasting a
`Export chat` .txt is the reliable route to a full analysis, so the parser handles the shapes
WhatsApp really writes: iOS bracketed and Android dashed, 12- and 24-hour, dot-separated
locales, and the invisible bidi control characters iOS emits (which silently defeat a parser
anchored on `[`). Multiline messages attach to their parent rather than splitting — that bug
does not crash anything, it just quietly reports that someone sends four times as many
messages as they do. See [`../whatsapp-analysis.test.mjs`](../whatsapp-analysis.test.mjs).

Authoring provenance lives in [`authoring/`](authoring/): the verbatim build prompt and the
vision / requirements / plan / lessons docs.

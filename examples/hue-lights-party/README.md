# hue lights party

Design a lighting scene for the party, then sync it to your Philips Hue bridge — **from
the desktop app**. On the web the designer works fully and the sync control is greyed,
with the reason stated.

The honest edge of the auth-spectrum shelf (AL-09 / roadmap A8b).

## Posture

| | |
|---|---|
| **Provider** | Philips Hue (LAN-local bridge) |
| **Credential kind** | **none — it constructs no AuthSpec at all** |
| **Declared host** | **none — this folder ships no `connection.json`** |
| **LLM posture** | **LLM-free** (ADR-0011): `RESPONSE_SCHEMA = null`, no `sendMessage` |
| **Live on web?** | **No** — authored and greyed, labeled desktop-only on its tile |

## Why this app is not connected

Hue's real model is a bridge **discovered on your local network**, authenticated with a
bridge username you obtain by pressing the physical link button on the device. That does
not fit the five-kind credential union at all: every kind assumes an internet host the
connected-fetch executor can reach and a credential the host can inject. A LAN address is
precisely what the SSRF guard blocks — correctly.

So rather than bend the protocol to fit one app, this starter (AL-09 D5/D10, AC9):

- **constructs no AuthSpec** and ships **no `connection.json`** — there is no honest
  declaration to make, and a fabricated one would be worse than none;
- **calls no seam.** It is deliberately outside `CONNECTED_APPS` in the validate suite,
  which is exactly why this file must never grow a `useConnectedFetch` call;
- **offers no connect button that cannot work.** The sync control is `disabled` and says
  *why* — a dead button opening a wizard that leads nowhere would be the dishonest option.

Desktop-native fetch is documented as a future rung of the auth ladder. The desktop
scaffold (roadmap A6) was **dropped from this run, not cancelled**, which is why this app
ships fully authored: the desktop child can light it up later without a rewrite.

## What still works on the web

Everything except the sync: pick a scene, adjust brightness, choose rooms, and watch the
preview respond. It is real UI on real state — only *apply to my lights* waits for desktop.

## Files

- `app.html` — the single-file app (hooks byte-synced to `packages/sdk/embedded/snug-hooks.js`).

No `connection.json`, by design. The declaration resolver treats a manifest-less folder as
"declares nothing" and grants it no exception of any kind.

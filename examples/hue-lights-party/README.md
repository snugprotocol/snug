# hue lights party

Design a lighting scene for the party, then connect your Philips Hue bridge — **from the
desktop app**. On the web the designer works fully, the tile says why it needs desktop,
and the sync control is greyed with the reason named.

The LAN edge of the auth-spectrum shelf (roadmap A8b; ADR-0023).

## Posture

| | |
|---|---|
| **Provider** | Philips Hue (a bridge on your own network) |
| **Credential kind** | `api_key` — **minted by the bridge, never typed** |
| **Declared host** | **none pinned** — `lanHost` says one will be COLLECTED |
| **LLM posture** | **LLM-free** (ADR-0011): `RESPONSE_SCHEMA = null`, no `sendMessage` |
| **Live on web?** | **No** — labelled desktop-only on its tile, honest inside |

## What changed, and what did not

This folder used to ship **no `connection.json` at all**, because there was no honest
declaration to make: every credential kind assumed an internet host the executor could
reach, and a bridge lives at an address your router assigned. ADR-0023 changed that.

- **`lanHost`** lets a requirement declare that a host will be *collected from the user*
  rather than pinned by an author. The wizard collects it (RFC-1918 IPv4 literal only),
  and the collected address freezes into the connection's host ceiling exactly like a
  pinned one would.
- **Pairing** replaces typing: press the round button on the bridge, and the wizard asks
  it for a key of its own. The key goes straight into the host's storage — this app never
  sees it, and neither does any model.
- **A TOFU certificate pin** is captured during that same exchange, so later requests
  verify the bridge against the certificate it actually presented rather than against a
  public root store it could never satisfy.

What did **not** change is the honesty rule this starter was written for: the one control
that cannot work here is *greyed and explained*, never hidden and never wired to a flow
that leads nowhere.

## The manifest is deliberately BARE

```json
{ "slot": "hue", "provider": { … }, "kind": "api_key",
  "lanHost": { "class": "rfc1918-ipv4-literal", "label": "Bridge IP address" } }
```

No `fields`, no `request`, no `declaredApiHosts`. A starter manifest borrows the `hue`
registry brand, and the admission guard refuses a borrowing channel that authors
credential-prompt copy or a request template — *where a credential is sent, and what the
user is told to type, are not an app author's to choose*. Omitting them is what makes the
registry's human-reviewed values get substituted instead. Adding a "helpful" `fields`
array would make this manifest unadmittable, and the app would install with a connection
that could never be created.

## How the app reaches the bridge without ever learning its address

**This app is never told the bridge's address** — and since ADR-0026, that is no longer
a limitation, just the boundary. Every request is a **connection-relative URL**:

    snug-connection://hue/clip/v2/resource/room
    snug-connection://hue/clip/v2/resource/grouped_light/<rid>   (PUT — the scene write)

The host resolves the `hue` slot to the single address the user approved into the frozen
ceiling, then runs every gate, injects `hue-application-key`, and scrubs the result —
exactly as it would for a literal URL. The app holds no hostname anywhere in its file;
the ceiling stays the only place the address lives, and the user's confirm dialog for
the first write names the real address the app cannot see.

On mount the app makes ONE probe that doubles as the data fetch (the rooms read).
Success renders the user's real rooms; a coded refusal picks the honest fallback —
`NET_NOT_APPROVED` shows the connect CTA, transport-shaped failures say the bridge is
unreachable from here, and `NET_AMBIGUOUS_CONNECTION` gets its own sentence (it is a
configuration problem the connect button cannot fix).

## What works before the bridge is connected

Everything except the lights themselves: pick a scene, adjust brightness, watch the
preview respond. Real UI on real state — and the rooms panel says plainly that real
rooms appear once Philips Hue is connected.

## Files

- `app.html` — the single-file app (hooks byte-synced to `packages/sdk/embedded/snug-hooks.js`).
- `connection.json` — the LAN-class declaration described above.

---
title: Envelopes & frames
description: The wire protocol in one page — thirteen frame types over postMessage, and the rules that keep them safe.
sidebar:
  order: 1
---

Everything between an app and its host crosses **one boundary** — `postMessage` between the
sandboxed iframe and the host page — as versioned JSON frames. Thirteen frame types exist,
all published as [JSON Schemas](/docs/spec/schemas/).

## The conversation shape

A mount is a handshake, then requests:

1. The host sends `snug:host-ready` — instance id, protocol versions, **capabilities**
   (`streaming`, `db`, `auth`, and optional `net`, `openUrl`).
2. The app announces itself: `snug:app-announce` (id, display name, icon hints).
3. The app asks its mind for things: `snug:app-message` (a request id, an action name, a
   structured payload, optionally a response schema) — answered by `snug:app-response`,
   which can stream text, return a final data object, or carry a typed error.

## The frame families

| Family | Frames | What it is |
|---|---|---|
| Agent bridge | `snug:app-message` · `snug:app-response` · `snug:app-cancel` | The runtime relationship — the app thinking through the host agent |
| Handshake | `snug:app-announce` · `snug:host-ready` | Identity and capability advertisement |
| Storage | `snug:db-request` · `snug:db-response` | Host-brokered SQL against the app's own isolated tables |
| Network | `snug:net-request` · `snug:net-response` | The **only** path to the network — governed by an approved host ceiling; the iframe itself has none |
| Navigation | `snug:open-url-request` · `snug:open-url-result` | The host opens the user's real browser, after its own confirm, on a user gesture |
| Events | `snug:host-event` · `snug:app-event` | Open additive channel (theme, visibility, resize, connection doorbells); unknown events are ignored |

## Why apps don't break

The spec's normative rules (R1–R7) are what make "an app written last year runs in next
year's host" true: frames are validated at the boundary, unknown *additive* surface is
tolerated where the rules say so, and capability flags — not version sniffing — tell an app
what its host can do. Absence of a flag is how an app knows to render a fallback rather than
a broken control.

Two details worth knowing early:

- **Streaming is cumulative.** A streaming `snug:app-response` re-sends the full text so a
  dropped frame cannot corrupt the result.
- **Frames have size classes.** An oversized *request* gets a terminal error naming the
  bound (never a silent drop) — but an oversized host-initiated *event* is dropped
  silently, which is exactly why push-style channels carry *invalidations* (a doorbell
  that triggers a governed refetch), never data.

> Normative source: [Part I — the wire protocol](/docs/spec/part-1-the-wire-protocol/).

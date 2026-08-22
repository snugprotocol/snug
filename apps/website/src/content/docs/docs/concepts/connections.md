---
title: Connections & credentials
description: How a sandboxed app reaches the user's real services — without ever holding a credential.
sidebar:
  order: 3
---

A Snug app has **zero network of its own** — and users still want apps that read their
calendar, control their lights, or chart their spending. Connections are how the protocol
squares that: the app *asks*, the host *executes*, and the credential never crosses into the
sandbox.

## The shape of a connection

- A **requirement** declares what a provider connection needs: which hosts, which fields
  (an API key, OAuth, basic auth…), which scopes. Requirements are reviewed and approved by
  the **user** in the host's wizard — never silently.
- A **grant** is the approved result: credential values in `snug_secrets` (inside the user's
  own file — custody is local-first, not a server vault), plus a **frozen ceiling** — the
  exact set of hosts this connection may ever reach, fixed at approval.
- The app then addresses the connection symbolically —
  `snug-connection://<slot>/<path>` — and never names a real host at all.

## Who may even ask

Because a connection is a credential grant, *who may propose one* is a protocol-level
posture. An app can never propose a connection at runtime — no frame exists that can do it.
The three channels that can (the user directly, the already-reviewed builder agent, and a
starter's install manifest) each get a defined review strength.

## The executor: where C1 lives

Every connected request runs through the **host-side connected-fetch executor** — the only
component that ever dials out:

1. The app sends `snug:net-request` (no credential fields exist in it — a credential header
   from an app is refused, not stripped-and-forwarded).
2. The executor checks the frozen ceiling, injects the credential *outside the iframe*,
   makes the request, and **scrubs the response** — credential echoes are removed before
   anything reaches the app, and harder still before anything reaches the LLM.
3. The app receives data, or a typed error that is honest about what happened.

Injection is always strict. There is no debug flag, demo mode, or config knob that weakens
it — a design constant across the reference implementation.

## Beyond request/response

Two provider families don't fit plain HTTP, and the spec covers both:

- **LAN-class providers** (Philips Hue): the device's address is collected from the user,
  frozen into the ceiling like any host, and pinned to the device's TLS identity.
- **Linked-device providers** (personal WhatsApp): a local, LLM-free helper process holds
  the device session; apps reach it only through the same governed executor, and live
  updates arrive as *invalidation doorbells*, never as pushed content.

> Normative source: [Part III — connected apps](/docs/spec/part-3-connected-apps/) and
> [Part V — linked-device connections](/docs/spec/part-5-linked-device-connections/).

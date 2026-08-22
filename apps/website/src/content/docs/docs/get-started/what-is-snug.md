---
title: What is Snug?
description: The mental model — bodies and minds, envelopes, one portable file.
sidebar:
  order: 1
---

Snug lets a user of any AI-assisted product say *"build me a habit tracker"* — and get a real,
running app: sandboxed, persistent, versioned, and **alive**, because at runtime it keeps
thinking through the same agent that built it.

## The body/mind split

A Snug app does not embed a model, an engine, or an API key. It is a **body**: UI, local state,
and a set of actions it can ask its **mind** — the host agent — to perform. A Snug chess game
sends the board to the host LLM over a standard postMessage envelope and animates the JSON
reply. The relationship is *runtime*, not codegen: the same app gets smarter when the user
upgrades their model, and cheaper when they point it at a small local one.

Two protocol features make that practical:

- **Envelopes** — thirteen versioned JSON frame types over `postMessage`, published as
  [JSON Schemas](/docs/spec/schemas/). An app works in any conformant host.
- **Runtime contracts** — each app carries a compact, version-pinned description of what it is
  and what a good answer looks like. Its turns are assembled from that contract, never from the
  conversation that built it, so a turn costs very little and runs well on any brain.

## One file, owned by the user

Everything a user builds lives in **one portable SQLite file** — the `.snug` file: every app's
code and version history, each app's own isolated database, the chats, the settings. It runs
from the browser (OPFS) or a desktop disk, syncs to an origin the user picks, exports and
imports whole, and can be sealed with a passphrase only the user holds.

There is no vendor database of your apps. The file **is** the account.

## Secure by construction

The security model is enforced by architecture, not by policy:

- Apps run in an iframe sandbox with `allow-scripts` only and **no network of their own**.
- The app's only path to the network is a host-mediated request pair, governed by a
  **human-approved, host-frozen ceiling** of allowed hosts.
- Credentials live in the user's own file and are injected by the host executor — they never
  enter the app iframe, never reach the LLM, and never reach an app publisher.

The [threat model and security argument](/docs/whitepaper/) are written down, including what
is accepted and *not* mitigated.

## Where Snug runs today

- **[The Playground](/docs/get-started/quickstart/)** — the hosted demo hub, zero install.
- **[The desktop app](/download/)** — Snug at full strength: fully private, local file, local
  models, LAN devices (Philips Hue), linked-device connections (personal WhatsApp).
- **Your product** — any SaaS can embed the runner + SDK and let its users build micro apps
  powered by its existing assistant. Start at the
  [implementor quickstart](/docs/get-started/implementors/).

> Normative source: [the specification](/docs/spec/). This page is the tour, not the contract.

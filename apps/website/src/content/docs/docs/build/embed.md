---
title: Embed Snug in your product
description: Give your existing AI assistant an app platform — the runner + SDK drop into your product, and your agent becomes the mind.
sidebar:
  order: 2
---

Your product has an AI assistant. Your users keep asking it for small bespoke things your
roadmap will never prioritize — a tracker shaped exactly like their week, a calculator for
their niche, a game for their kid. Embedding Snug turns those conversations into **apps**:
built in your chat, run in your product, powered by the agent you already operate.

## What embedding means

Three pieces drop into your web app:

1. **The runner** (`@snugprotocol/runner`) — renders app iframes with the sandbox contract
   enforced and bridges frames to the host page. Your CSP work is reviewing what it
   enforces, not inventing it.
2. **The agent transport** — one seam where the runner hands you an app's request and you
   answer it with *your* assistant. Stream if you can; the SDK's result shape is the same
   either way.
3. **Storage** (`@snugprotocol/db`) — a per-user file your product holds (and lets the user
   export — that's the deal that makes this a protocol rather than a feature).

The **builder side** — letting users create apps in your chat — reuses
`@snugprotocol/knowledge`, the app-authoring knowledge base that teaches your agent to write
good single-file apps against the SDK.

## What your users get

- Apps that keep **thinking through your assistant** at runtime — your product's
  intelligence becomes the apps' intelligence.
- Their own data, per app, isolated — and exportable as a real file. Portability is a
  feature you *offer*, not a risk you absorb: the file format is an open spec.
- A sandbox you can defend in a security review: no app network, no credential exposure,
  validated envelopes at the boundary — with a published
  [threat model and whitepaper](/docs/whitepaper/) to cite.

## What it costs you

Honest ledger:

- **A day to first running app.** Runner + a transport stub against your assistant is an
  afternoon; the Playground source is the worked example.
- **Turn costs stay flat.** [Runtime contracts](/docs/concepts/runtime-contracts/) keep
  per-turn overhead near a kilobyte — an embedded app is not a context bomb.
- **The hard rules are non-negotiable.** If your integration needs credentials inside the
  iframe or a hole in `connect-src`, that isn't a Snug integration anymore — the security
  claims you inherit are exactly as strong as the constraints you keep.

## Start

```bash
pnpm add @snugprotocol/runner @snugprotocol/sdk @snugprotocol/db @snugprotocol/knowledge
```

Then read [Host a hub client](/docs/build/hub-client/) — an embedder is a hub client whose
agent and account system already exist. Stages 1–4 are your integration; stage 5
(connections) is optional until your users want apps that reach their other services.

> Packages publish from [the reference repo](https://github.com/snugprotocol/snug). If a
> version you need isn't on npm yet (pre-1.0 they ship with launch moments, not
> continuously), consume the packages from a clone of the monorepo — they build with one
> `pnpm build`. Pin exact versions and read the spec-changelog before upgrading.

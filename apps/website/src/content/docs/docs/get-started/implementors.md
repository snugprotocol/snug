---
title: Implementor quickstart
description: The map for building a hub client or embedding Snug in your product — what to implement, in what order, and what the reference gives you for free.
sidebar:
  order: 4
---

You are here because you want one of two things:

1. **Embed Snug in your product** — your SaaS already has an AI assistant; you want your users
   to build micro apps with it.
2. **Build a hub client** — a new host (web, desktop, or something else) that runs Snug apps
   and owns a user file.

Both are the same protocol; they differ in how much you build versus reuse.

## The shortest path: reuse the reference packages

The reference implementation is a set of MIT-licensed TypeScript packages, extracted from a
production system:

| Package | What it gives you |
|---|---|
| `@snugprotocol/protocol` | Typed envelope bindings — the source of truth for the published schemas |
| `@snugprotocol/runner` | The sandboxed iframe runner + bridge host (the C2 enforcement seat) |
| `@snugprotocol/sdk` | The in-app hooks apps are written against (`useSnugApp`, `useAppDB`, …) |
| `@snugprotocol/db` | The portable user database: sql.js + OPFS, `.snug` export/import, optional encryption |
| `@snugprotocol/auth` | Dynamic Auth + the connected-fetch executor (the C1 enforcement seat) |
| `@snugprotocol/knowledge` | The LLM app-authoring knowledge base — what makes builds *good* |
| `@snugprotocol/adapters` | Anthropic / OpenAI / mock agent adapters |

An embedding host drops in the **runner + SDK + knowledge**, wires the runner's agent
transport to its existing assistant, and stores per-user files with **db**. The Playground
(`apps/playground`) is the worked example of exactly that assembly, and
`apps/desktop` shows the same source hosted in a native shell.

## Building from scratch: implement the spec

A conformant host implements, in rough order of effort:

1. **The wire protocol** ([Part I](/docs/spec/part-1-the-wire-protocol/)) — thirteen frames
   over `postMessage`, versioned, validated at the boundary. The
   [schemas](/docs/spec/schemas/) are published byte-identical from the reference.
2. **The sandbox contract** — apps run with `allow-scripts` only and no network of their own.
   This is a hard conformance property, not a default.
3. **The portable user database** ([Part II](/docs/spec/part-2-the-portable-user-database/)) —
   one SQLite file per user; hub-namespace tables plus per-app native tables. If your host
   can open, mutate, and round-trip a `.snug` file, your users can leave and come back.
4. **Connected apps** ([Part III](/docs/spec/part-3-connected-apps/)) — requirements, grants,
   credential custody, and the host-side fetch executor with its frozen per-connection
   ceiling. This is where C1 (credentials never reach the app or the LLM) is enforced.
5. **Runtime contracts** ([Part IV](/docs/spec/part-4-runtime-contracts-and-the-app-chat-surface/))
   — the compact per-app turn assembly that makes runtime thinking cheap.

[Part VI — Conformance](/docs/spec/part-6-conformance/) states what a host must, should, and
may do; the [appendices](/docs/spec/appendices/) carry the error-code registry and the
normative constants.

## Why bother

The pitch to your product team is one sentence: **your assistant stops being a feature and
becomes a platform** — users build the long tail of tiny tools your roadmap will never reach,
inside your product, against your agent, with a security story you can hand to your CISO
([whitepaper](/docs/whitepaper/), threat model included).

Questions the docs don't answer: open an issue on
[the reference repo](https://github.com/snugprotocol/snug) — protocol discussion happens
there, and the spec repo takes typo/clarity PRs directly.

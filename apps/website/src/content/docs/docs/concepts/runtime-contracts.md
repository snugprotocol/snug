---
title: Runtime contracts
description: Why a Snug app's turns are cheap, portable across models, and independent of the chat that built it.
sidebar:
  order: 4
---

The obvious way to let a built app keep talking to the agent is to keep the build
conversation around and append to it. It's also the wrong way: turns get more expensive
forever, the app's behavior drifts with the chat, and nothing smaller than a frontier model
can host it.

Snug specifies the alternative: the **runtime contract**.

## What it is

When an app version is created, the host assigns it a compact, version-pinned contract — a
structured description of *what this app is* and *what a good answer looks like* for its
actions. Every runtime turn for that app is assembled from the contract, never from the
conversation that built it.

The measured effect in the reference implementation is on the order of a kilobyte saved per
turn — which is precisely what makes a small local model a viable mind for an app.

## The properties that matter

- **Pinned to the version.** Edit the app and the contract moves with the edit; revert the
  app and the contract of the *target* version is restored. The app you run is always the
  app the contract describes.
- **Trust has provenance.** An imported file's contracts are dropped unless the hub already
  holds byte-identical ones — a foreign file cannot smuggle instructions into your agent's
  system assembly.
- **Model-portable.** Because a turn carries the contract and the action payload rather than
  a history, the same app runs well on a frontier model, a mid-tier one, or the small local
  brain — the user's choice, per app if they like.

## The app chat surface

The contract also powers the app-attached chat. A message beside an installed app is
**intent-classified first**, and the intent picks both the context assembled and the tools
offered:

- **Data questions** run agent-authored SQL on an isolated *copy* of the app's own database —
  "what did I spend on food last month?" works on a budget app that never shipped that
  screen.
- **Data changes** are proposed with the verbatim statements and row counts, execute only on
  the user's approval, and re-validate before applying.

> Normative source: [Part IV — runtime contracts and the app chat surface](/docs/spec/part-4-runtime-contracts-and-the-app-chat-surface/).

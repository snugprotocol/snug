---
title: Build your first app
description: You talk, the agent writes — here is what it actually produces, and how to read it.
sidebar:
  order: 3
---

You don't usually *write* a Snug app — you describe one, and the host agent writes it. But the
artifact it produces is small enough to read over coffee, and reading one is the fastest way to
understand the protocol.

## Describe it

In the Playground (or the desktop app), type something like:

> a pocket chess coach — I play white, you play black, explain your moves briefly

The builder agent writes a **single HTML file**, versions it in your user file, and mounts it
in the sandbox. That's the whole deployment story.

## What it produced

A Snug app is one self-contained HTML file using the SDK hooks. The important parts:

```jsx
// announce who you are; isReady flips when the host acks
const { isReady, sendMessage } = useSnugApp({
  appId: 'pocket-chess-coach',
  displayName: 'Pocket Chess Coach',
});

// ask the host agent for its move — this is the runtime bridge
const reply = await sendMessage('opponent-move', { lastMove: 'e7e5' });
if (reply.ok) applyMove(reply.data.move);

// the app's own isolated database, inside YOUR user file
const db = useAppDB();
await db.exec('INSERT INTO games (pgn, played_at) VALUES (?, ?)', [pgn, Date.now()]);
```

- `sendMessage` rides the `snug:app-message` / `snug:app-response` frame pair — the app never
  sees a provider, a key, or even *which* model answered.
- `useAppDB` is host-brokered SQL against tables that belong to this app alone. Physical
  isolation — the app's runtime database is materialized from its own namespaced tables.
- `usePersistedState` is the small-state shortcut for the same storage.

## What it cannot do

The sandbox is the point:

- **No network.** `connect-src` is blocked; the only path out is the governed
  [connected-fetch surface](/docs/concepts/connections/), inside a ceiling you approved.
- **No credentials.** Tokens are injected by the host executor, outside the iframe, always.
- **No other app's data.** Each app sees only its own tables.

## Living apps

Every app keeps an attached chat. Ask the app's chat *"what did I spend on food last month?"*
and the host classifies your intent, runs agent-authored SQL **on an isolated copy** of the
app's data, and — for changes — shows you the exact statements and row counts before anything
applies. Apps are versioned with a pinned factory version, so *reset to factory* and *revert*
always exist.

> Normative source: [Part I — the wire protocol](/docs/spec/part-1-the-wire-protocol/) and
> [Part IV — runtime contracts](/docs/spec/part-4-runtime-contracts-and-the-app-chat-surface/).

---
title: The user file (.snug)
description: One portable SQLite file per user — every app, every app's data, chats, settings. The file is the account.
sidebar:
  order: 2
---

Snug has no vendor database of your apps. Everything a user builds lives in **one SQLite
file** — the `.snug` file — and the protocol specifies its format so any conformant hub can
open it. Ownership is not a promise here; it's a file handle.

## What's inside

Two table families share the file:

- **Hub-namespace tables** (normative DDL in the spec): the apps and their pinned versions
  (a factory version plus recent history — *revert* and *reset to factory* always exist),
  per-app chats, the schema registry, settings, connections, and `snug_secrets`.
- **Per-app native tables** — each app's own data, in namespaced tables designed by the
  agent *for that app*. At load, an app's tables are materialized into its own runtime
  database, so isolation between apps is physical, not a naming convention.

It's real SQLite. `sqlite3 my-life.snug '.tables'` works, and that's by design.

## Where it lives, how it moves

- **Browser hosts** keep the working copy in OPFS with crash-safe slot writes.
- **Desktop** keeps it at `~/Snug` on your own disk.
- **Sync** goes to an origin the *user* picks — a hub, Dropbox, or nothing at all. Secrets
  are stripped from hub-bound copies and from default exports.
- **Export / import** move the whole file. Leaving a hub is downloading a file.

## Protected files

Encryption at rest is opt-in: the file is sealed whole into a `SNUGENC1` container
(AES-256-GCM), key-wrapped so a passphrase and a mandatory Recovery Key are independent
unlock paths. A protected file opens as *locked* — and the format keeps "wrong passphrase"
and "damaged file" distinguishable, because telling a user the wrong one is a frightening
lie. Losing **both** secrets loses the data; the spec says so plainly rather than implying a
backdoor exists.

## Why this matters

Every other differentiator leans on this one. Apps can be *living* (their chat can query
their own data) because the data is right there in the user's file. Hosts can be swapped
because the file is the account. And the credential story ([connections](/docs/concepts/connections/))
can be local-first because `snug_secrets` travels inside the user's own property, not a
server vault.

> Normative source: [Part II — the portable user database](/docs/spec/part-2-the-portable-user-database/).

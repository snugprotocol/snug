# Inbox Copilot — the AI inbox manager

The eighth connected starter (TASK-20260819-gmail-starter, ADR-0039). Gmail's own app
reads mail well. What it does not do is tell you **who is actually filling your inbox**,
**which senders you have never once answered**, and **what you can safely remove in
bulk** — with an assistant that can see the whole distribution and an approval step you
control.

Four lanes:

| lane | what it answers |
| --- | --- |
| **Pulse** | Twelve weeks of arrivals as a trend line, who sends the most, and what the inbox is actually made of — plus a one-line briefing from the assistant and a box for a quick question |
| **Needs you** | Senders with 3+ emails and **no reply from you** (receipts and anything starred deliberately excluded), and the lists that publish an unsubscribe route |
| **Do this** | Runnable suggestion cards — the assistant proposes, you preview, one confirm runs it. No leaving the page, no writing a query |
| **Mass cleanup** | Select any number of senders and trash, file, spam, or block them in one governed batch |

## What makes it safe enough to point at real mail

- **It cannot permanently delete anything.** The registry pins `gmail.modify`,
  `gmail.settings.basic` and `gmail.send` — and deliberately *not*
  `https://mail.google.com/`, the only Gmail scope that permits `messages.delete`.
  Trash-only is a property of the minted token, not a promise made by this code
  (ADR-0039 D3). Gmail keeps trashed mail for 30 days.
- **Nothing runs unpreviewed.** Every action stages a plan naming the exact count and
  senders it will touch. The plan object *is* the confirm copy and *is* the request
  body, so what you approve and what runs cannot drift apart — then the host confirms
  again before the write leaves.
- **Metadata only.** The sync reads `From`, `To`, `Subject`, `Date` and
  `List-Unsubscribe` via `format=metadata`. It never asks for message bodies.
- **Blocking is a filter, not a deletion.** "Block future mail" creates a real Gmail
  filter that auto-trashes what has not arrived yet, leaving your existing inbox alone.
- **Unsubscribe splits by what the sandbox can honestly do.** A `mailto:`
  List-Unsubscribe becomes one confirmed `gmail.send`. An `https` link goes to your
  real browser through the open-url bridge (ADR-0038 D5) behind an https-only,
  no-userinfo gate — the app can only ever reach `gmail.googleapis.com`, so it must not
  pretend otherwise. RFC 8058 one-click POST is out of scope for the same reason.

## Sample mode

The app opens on a **deterministic 90-day sample inbox** — thirteen senders in RFC 2606
reserved domains, seeded so every render is identical. Every lane is populated before
anything is connected: the trend line, the never-replied flags (including the two traps
a naive rule gets wrong — a bank's receipts and a starred newsletter), both unsubscribe
channels, and a mass-cleanup dry run that reports what it *would* do. Connect Gmail and
the same code runs against your own mail.

## Connecting

The connection wizard drives it. Gmail is a well-known provider, so the walkthrough,
the pinned scopes and the two credential fields all come from the registry — the
manifest here is deliberately **bare** (slot, brand, kind, one host). You will create a
free Google Cloud project and a Desktop-app OAuth client; the wizard walks each screen,
including the two Google traps: the "unverified app" warning, and the 7-day connection
expiry that applies until you publish the project.

## Tests

```sh
pnpm --filter examples test
```

`gmail-analysis.test.mjs` evaluates the app's pure core directly — the never-replied
rule and its exclusions, the unsubscribe ranking and channel split, the URL gate, the
chart reducers, and the batch planner (including that no plan can express a deletion,
and that a 2,500-message cleanup splits into API-legal chunks).

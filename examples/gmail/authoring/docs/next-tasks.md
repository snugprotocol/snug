# Next tasks — Inbox Copilot

- **Web-playground support.** v1 is desktop-only: a Google Desktop-app OAuth client
  registers loopback redirects only. A Web-application client type plus a
  posture-branched walkthrough would open the browser lane.
- **Incremental sync.** Today's refresh re-reads the 90-day window. `historyId` would
  make refreshes cheap and allow a much longer window.
- **Undo for a completed batch.** Trash is reversible in Gmail, but the app should be
  able to walk a batch back itself — it holds the message ids it moved.
- **Label taxonomy proposals.** The assistant can already classify senders; proposing a
  small set of labels and filing into them is the natural next lane.
- **Attachment and storage view.** "What is eating my 15GB" is the other question people
  cannot answer by scrolling; it needs `sizeEstimate`, which the metadata sync already
  returns.
- **RFC 8058 one-click unsubscribe**, if a future host-side capability ever makes a
  single POST to a sender-declared host expressible without widening the app's ceiling.

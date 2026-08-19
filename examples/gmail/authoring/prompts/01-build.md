# 01 — build prompt (verbatim)

The dev-time prompt that produced `app.html`, kept verbatim as the app's provenance
(ADR-0031/ADR-0035). Assembled from the app-authoring KB
(`packages/knowledge/prompts/knowledge-base/app-authoring/`) — the HTML template, the
bridge protocol, the connected-APIs section, defensive coding, and design quality.

---

Build **Inbox Copilot**, a Snug micro app connected to Gmail.

**The problem.** Gmail already shows people their mail. What it hides is the shape of
it: which senders dominate, which ones a person has never once answered, and what could
be removed wholesale without losing anything they would miss. Doing that by hand means
hundreds of searches. Build the app that does it in four screens.

**Connection.** One Gmail account. Declare a BARE `connection.json` — slot `gmail`,
provider Gmail, kind `oauth2_auth_code`, `declaredApiHosts: ["gmail.googleapis.com"]`
and nothing else; the registry supplies scopes, credential fields and the console
walkthrough on the borrow hit. Reach the API only through `useConnectedFetch`.

**Sync metadata only.** `users.messages.list` with `newer_than:90d`, then
`format=metadata` with `metadataHeaders` for From, To, Subject, Date and
List-Unsubscribe. Never request message bodies — an app that does not fetch something
cannot leak it. Paginate, and let a partial sync still render.

**Four lanes.**
1. *Pulse* — twelve-week volume trend, top senders, category mix, all as hand-drawn
   inline SVG (no chart library). Plus an assistant briefing and a one-line question box.
2. *Needs you* — senders with 3+ received and zero replies from the user. **Exclude
   transactional senders** (receipts, invoices, orders, shipping, security alerts) and
   anything the user starred or marked important: being unanswered only means unwanted
   when a reply was ever possible. Alongside it, the senders that publish a
   List-Unsubscribe route.
3. *Do this* — runnable suggestion cards. The assistant proposes; the card previews;
   one confirm runs it. This lane exists so a person never has to compose a query.
4. *Mass cleanup* — multi-select senders, then trash / file / spam / block in one batch.

**Write posture — the part that matters most.** Every destructive action stages a plan
first, and the plan object must be *both* the confirm copy and the request body so the
two cannot drift. State the exact count and senders. Bulk trash rides
`messages.batchModify` with `addLabelIds:['TRASH']`, chunked at 1000 ids — never a
delete call of any kind; the granted scopes cannot permanently delete and the app must
not imply otherwise. Blocking creates a Gmail filter (`settings/filters`), which is why
this app holds `gmail.settings.basic`. For spam, say "move to Spam" — adding the SPAM
label is not the classifier signal Gmail's own Report Spam button sends, and
overclaiming would promise protection the app cannot deliver.

**Unsubscribe, split by channel.** A `mailto:` List-Unsubscribe becomes one confirmed
`gmail.send`. An `https` link goes to the system browser through the open-url bridge
(post `snug:open-url-request`, hand-rolled outside the byte-locked hooks block, as
Ledger does) behind an https-only, no-userinfo gate — a hostile header is an injection
surface, not just bad data. There is no third option: the app can only reach
`gmail.googleapis.com`.

**Sample mode.** Open on a deterministic 90-day sample inbox from a seeded PRNG, all
addresses in RFC 2606 reserved domains, wrapped in `GMAIL-SAMPLE-BEGIN/END` markers with
no clock or bridge inside. It must populate every lane and include the two cases a naive
never-replied rule gets wrong — a bank's receipts, and a starred newsletter — because
the demo's job is to show the judgment, not just the counts.

**Structure for testing.** Put the whole pure core between `GMAIL-CORE-BEGIN` and
`GMAIL-CORE-END` markers: the reducers, the flags, the ranking, the URL gate, the batch
planner, the sample builder. No bridge, no clock, no network inside — the suite
evaluates that region directly, and the same purity is why the numbers on screen can be
trusted.

**Tone.** The user is not embarrassed about their inbox and the copy must not imply they
should be. Concrete counts and names over adjectives. Say what a cleanup costs, not just
what it saves.

**Contract.** One self-contained `app.html`. React 18 UMD + Babel standalone from the
CDN allowlist. The embedded hooks block copied byte-identical from
`packages/sdk/embedded/snug-hooks.js`, everything app-authored after the
`// 5. RESPONSE SCHEMA` banner. Announce metadata, full state + `responseSchema` on every
`sendMessage`, graceful `ok:false` handling and a local fallback for every agent lane
(the app must be useful with no agent at all). No form elements, no browser storage, no
direct `fetch`. Theme-aware via `data-theme`, usable at 375px, ≥44px touch targets,
skeletons over spinners.

# Lessons

What building Telepath taught, kept where the next person will read it.

**A doorbell beats a delivery.** The first design had the host pump forward message content
into the app frame. Two verified facts killed it: host-event frames ride the ordinary 256 KB
frame class, and the runner's `post()` drops an oversized frame *silently* — so a busy group
would have made live updates vanish with no error anywhere. And host-event frames carry no
`instanceId`, so a hand-rolled app listener cannot tell a stale sender from a live one.
Forwarding only `{jid, kind, ts}` fixed both at once: the frame can never outgrow its class,
and a stale hint costs one redundant governed refetch instead of injecting wrong state. When
a push channel is hard to make safe, push the *invalidation*, not the data.

**The library will not maintain your counter.** Baileys reports `unreadCount` only as a
snapshot on synced conversations — it never increments live. A design that assumed a live
field would have shipped a badge that never moved. Read the `.d.ts`, not the memory of the
API: the sidecar seeds from the snapshot and increments itself, and the phone's later
snapshot overwrites the running count (that is how "I read it on my phone" clears a badge).

**A cap must refuse, never truncate.** Media crosses a 1 MiB transport. A truncated image is
a corrupt file wearing a `200`; the honest answer is a structured `{tooLarge: true}` plus the
thumbnail that already rode with the message. Refuse *before* downloading when the declared
size already busts the cap — spending the user's bandwidth to throw bytes away is its own
defect.

**Expired links are the normal case, not the edge.** WhatsApp's media CDN URLs expire, and
`downloadMediaMessage` takes a context (`reuploadRequest`) precisely so the session can
re-request them. Skipping that optional argument would have made every older photo silently
un-fetchable — the kind of failure users read as "this app is broken" and developers never
reproduce, because their fixtures are always fresh.

**Two directions of one boundary.** The POC scrubbed identities on the way *out*. Telepath
also maps labels back on the way *in*, and the reverse direction has its own failure mode:
replace `P1` before `P12` and a profile of one human being gets attributed to another. Both
directions are pure functions with hostile fixtures, and the map is persisted so `P2` keeps
meaning the same person across incremental runs.

**Adjacent emoji are not one emoji.** The first frequency pattern let `Extended_Pictographic`
repeat inside a single token, so `😂😂` counted once as an emoji nobody has ever sent. A
token extends through modifiers and ZWJ sequences only. The test that caught it asserted a
*count*, not a shape — measure the thing the feature promises.

**A negative check needs a positive twin.** `ipc-sidecar-fetch-refused` passed while the
command was unregistered: an unreachable-from-everywhere command satisfies an unreachability
check perfectly. Every "X cannot reach Y" check now owes a companion proving X *can* reach Y
from where it legitimately should — otherwise the check vouches for nothing.

**Timezone is part of the fact.** "When is this chat alive?" drawn in UTC is confidently
wrong in every bucket for most of the world. The aggregator takes an explicit offset and the
test drives a 23:30 UTC message across midnight — the bug is invisible in any fixture that
does not cross a boundary.

# Vision

Snug's pitch is that you own the runtime, so you can have apps no gatekept store would ever
approve. That claim is cheap until something demonstrates it. WhatsApp Twin is the
demonstration: it links a *personal* WhatsApp account as a companion device, reads one thread
closely enough to describe the people in it, learns how the owner themselves writes, and
drafts replies in that voice — including unattended ones, while armed.

No app store would ship this. The provider's own terms forbid it. It profiles people who
never consented. It speaks in the user's name. Every one of those is a real objection, and
the app answers each in the open rather than by being quiet about it: the ToS risk is stated
before the connect button and again in the README; participants are pseudonymised before any
model turn, so what reaches the provider is the conversation's shape and not its roster;
every unattended send is journaled where the user can read it; and one control deletes
everything derived from a thread.

The protocol case underneath is narrower and more durable than the app. Some providers
authenticate a *device*, not a request — no key to type, no OAuth redirect, just a QR scan and
a long-lived session that a sandboxed iframe and a request/response executor structurally
cannot host. Twin is the reference implementation of that shape (ADR-0032), and of standing
scoped write approval (ADR-0033), which is what "the LLM proposes, the human approves" has to
mean when the approval necessarily happens before the act.

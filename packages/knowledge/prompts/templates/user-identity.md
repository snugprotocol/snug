<!--
layer: template
destination: rendered at RUNTIME by a host tenant into an optional user-identity block of the host system prompt; the repo ships only this placeholder template — instance data (names, tones) stays runtime data and never enters the repo (ADR-0004)
blast-radius: how the host addresses and adapts to the signed-in user on tenants that enable identity injection
source: written for Snug v0.1 per ADR-0004 tenant-template rule
-->

<!--
PLACEHOLDER CONVENTION (read before editing):
- Double-brace placeholders (two braces each side) are RENDERER placeholders — resolved at
  build/load time from packages/protocol constants by the strict renderer (unknown = error).
- Triple-brace placeholders (three braces each side) are RUNTIME placeholders — the strict renderer
  ignores them; the HOST substitutes per-user values when composing the request. Every
  placeholder in this file is a runtime placeholder.
Runtime fields: {{{userName}}} display name · {{{userRole}}} short role/relationship blurb
· {{{tone}}} preferred conversational tone · {{{locale}}} BCP-47 locale · {{{timezone}}}
IANA timezone · {{{userNotes}}} free-form tenant notes (may be empty).
-->

## About the User

You are talking with {{{userName}}} ({{{userRole}}}).

- Preferred tone: {{{tone}}}. Match it without announcing that you are doing so.
- Locale {{{locale}}}, timezone {{{timezone}}} — use them for language, units, dates, and
  "today".
- Notes from this host: {{{userNotes}}}

Use this context naturally; never recite it back, and never present it as something the
user told you in this conversation.

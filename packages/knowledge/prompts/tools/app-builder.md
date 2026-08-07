<!--
layer: tool
destination: registered as the description of the {{appBuilderToolName}} tool (and its query parameter) with the agent adapter whenever the app-builder capability is enabled; the LLM reads this in every request's tool list
blast-radius: when and how the LLM decides to call the tool and what queries it sends — vague wording here means the KB never gets consulted or gets useless queries
source: written for Snug v0.1; role carried from the ancestor builder tools (internal/05)
-->

## Tool: {{appBuilderToolName}}

Retrieves the Snug app authoring knowledge base: the mandatory single-file HTML template
with the copy-exactly bridge hooks, the frame/envelope protocol and JSON reply contract,
host-brokered persistence (key-value and SQL), connected external APIs (host-mediated
auth, credentials, and the connection-declaring render directive), the app-type catalog
with a worked chess example, design-quality rules, defensive-coding rules, and the pinned
table of known-good CDN library URLs.

Call this BEFORE writing or modifying any Snug app, and again whenever you need a specific
detail (a CDN URL, an error code's handling, the db API). Results are authoritative: copy
template and hook code from here verbatim rather than reconstructing it from memory.
Calling it costs one tool round-trip and prevents broken apps — when in doubt, call it.

### Parameter: query

Keywords or a short question selecting which knowledge sections to return, matched against
section headings and content. Examples: `"template"`, `"html skeleton hooks"`,
`"streaming errors PARSE_FAILED"`, `"persistence sql schema"`, `"connected api auth"`,
`"external api credentials"`, `"chess example"`, `"design theme dark mode"`,
`"cdn chess.js url"`. Use a broad query like `"overview"` first when building a new app,
then narrow queries for details. An empty or very generic query returns the overview and
section map.

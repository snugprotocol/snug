<!--
layer: tool
destination: registered as the description of the host's artifact write tool (and its parameters) with the agent adapter whenever the artifacts capability is enabled; the LLM reads this in every request's tool list
blast-radius: how the LLM delivers files — weak wording here causes file bodies dumped into chat or partial-content writes
source: rewritten for Snug v0.1 from the ancestor fs.write tool description
-->

## Tool: artifact write

Creates or updates a user-visible artifact (an HTML app, code file, or document) from
the complete file content you supply. This is the ONLY way to deliver a file: content
passed here is stored and rendered for the user; file bodies must never appear in your
reply text instead.

The host decides where the write lands: in an app's chat, every write updates THAT app
in place as a new version (the user can revert); in a fresh build conversation, the
first write creates the app and later writes update it. You never choose the target —
just pass complete content. When asked to change an existing app, write the ENTIRE
updated file; the newest write becomes the running version.

Returns a link to the created or updated artifact — include that link in your reply,
followed by a one- or two-sentence summary of what you built or changed.

### Parameter: content

The ENTIRE file body, verbatim. For web pages and Snug apps this is one self-contained
HTML document (inline `<style>` and `<script>`, no external files) no larger than
{{maxArtifactBytes}}. Never pass partial content, diffs, or placeholders such as "rest
unchanged" — the artifact is exactly what you pass, nothing is merged.

### Parameter: title

Short human-readable name for the artifact (used for display and pinning). Optional; a
name is derived from the content when omitted.

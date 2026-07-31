<!--
layer: tool
destination: registered as the description of the host's artifact write tool (and its parameters) with the agent adapter whenever the artifacts capability is enabled; the LLM reads this in every request's tool list
blast-radius: how the LLM delivers files — weak wording here causes file bodies dumped into chat or partial-content writes
source: rewritten for Snug v0.1 from the ancestor fs.write tool description (internal/05)
-->

## Tool: artifact write

Creates a user-visible artifact (an HTML app, code file, or document) from the complete
file content you supply. This is the ONLY way to deliver a file: content passed here is
stored and rendered for the user; file bodies must never appear in your reply text instead.

Returns a link to the created artifact — include that link in your reply, followed by a
one- or two-sentence summary of what you built.

### Parameter: content

The ENTIRE file body, verbatim. For web pages and Snug apps this is one self-contained
HTML document (inline `<style>` and `<script>`, no external files) no larger than
{{maxArtifactBytes}}. Never pass partial content, diffs, or placeholders such as "rest
unchanged" — the artifact is exactly what you pass, nothing is merged.

### Parameter: title

Short human-readable name for the artifact (used for display and pinning). Optional; a
name is derived from the content when omitted.

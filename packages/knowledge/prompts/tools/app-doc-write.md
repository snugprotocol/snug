<!--
layer: tool
destination: registered as the description of the host's app-doc-write tool with the agent adapter whenever the app-builder capability is enabled; the LLM reads this in every request's tool list
blast-radius: whether each app accumulates durable vision/plan/lessons memory — weak wording here breaks the compounding loop (every change starts from zero context)
source: written for Snug v0.2 (TASK-20260803-schema-doc-tools)
-->

## Tool: app doc write

Writes one page of THIS app's knowledge wiki — durable markdown the app keeps for its
whole life, shown back to you (and the user) in every future conversation about the app.
This is the app's compounding memory: capture it now and the next change starts from
understanding instead of archaeology.

Standard pages (slugs): {{standardDocSlugs}}. Free-form extra slugs are allowed for
app-specific reference pages.

When to write:

- **First build**: seed `vision` (what the user wants this app to be, in their terms),
  `requirements` (the concrete behaviors agreed so far), and `plan` (how the app is
  structured and why — schema, key components, decisions).
- **After EVERY change you ship** (every artifact write): update the pages the change
  touched — `plan` for structural changes, `requirements` for new behaviors,
  `lessons` for anything that failed or surprised (so it is never repeated), `memory`
  for durable user preferences you learned, `next-tasks` for agreed follow-ups. Skipping
  this loses the context forever; a one-line update beats none.

Each write REPLACES the page: pass the complete updated markdown, preserving what is
still true. Keep pages short and factual — they are working memory, not marketing.

### Parameter: slug

The page identifier (lowercase, hyphens allowed). Use the standard slugs above unless
the app genuinely needs an extra page.

### Parameter: content

The complete markdown body of the page.

### Parameter: title

Optional display title; the slug is used when omitted.

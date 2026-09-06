<!--
layer: ui
destination: composed CLIENT-SIDE by the Playground into the user message sent when someone submits an app idea (typed or via a suggestion chip); runtime placeholder {{{appIdea}}} is filled by the Playground, not the renderer; the "(tool-free)" twin is sent instead when the build's brain cannot call tools (webllm, a tool-less host brain — TASK-20260906)
blast-radius: the very first instruction of every Playground build flow — changes here shift what kind of apps get built and whether the KB gets consulted; the tool-free twin must never name a tool (a tool-free brain told to use one built a bridge-less app — T4's hosted walk)
source: written for Snug v0.1; suggestion chips informed by the ancestor app catalog
-->

## User Message Template

Build me a Snug app: {{{appIdea}}}

Use the `{{appBuilderToolName}}` knowledge base first to get the mandatory template and
bridge hooks, then create the app as a single self-contained HTML artifact. Make it feel
polished — both themes, sensible empty state, and give the AI side of it a bit of
personality.

## User Message Template (tool-free)

Build me a Snug app: {{{appIdea}}}

The authoring rules — the mandatory template, the bridge hooks, persistence, the CDN table —
are in your instructions; follow them exactly and reply with the whole app as one complete
self-contained HTML document. Make it feel polished — both themes, sensible empty state,
and give the AI side of it a bit of personality.

## DATA: Suggestion Chips

> DATA SECTION — the Playground renders these six ideas as one-tap chips; each chip's text
> replaces {{{appIdea}}} in the template above.

- chess with an AI opponent that trash-talks (politely)
- a flashcard trainer that generates cards on any topic I name
- 20 questions — the AI guesses what I'm thinking of
- a workout tracker where I can ask questions about my history in plain English
- a collaborative story builder — we alternate paragraphs
- a quiz-show host that grills me on a topic of my choice

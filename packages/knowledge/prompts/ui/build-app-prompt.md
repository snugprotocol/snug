<!--
layer: ui
destination: composed CLIENT-SIDE by the Playground into the user message sent when someone submits an app idea (typed or via a suggestion chip); runtime placeholder {{{appIdea}}} is filled by the Playground, not the renderer
blast-radius: the very first instruction of every Playground build flow — changes here shift what kind of apps get built and whether the KB gets consulted
source: written for Snug v0.1; suggestion chips informed by the ancestor app catalog (internal/05)
-->

## User Message Template

Build me a Snug app: {{{appIdea}}}

Use the `{{appBuilderToolName}}` knowledge base first to get the mandatory template and
bridge hooks, then create the app as a single self-contained HTML artifact. Make it feel
polished — both themes, sensible empty state, and give the AI side of it a bit of
personality.

## DATA: Suggestion Chips

> DATA SECTION — the Playground renders these six ideas as one-tap chips; each chip's text
> replaces {{{appIdea}}} in the template above.

- Chess with an AI opponent that trash-talks (politely)
- A flashcard trainer that generates cards on any topic I name
- 20 Questions — the AI guesses what I'm thinking of
- A workout tracker where I can ask questions about my history in plain English
- A collaborative story builder — we alternate paragraphs
- A quiz-show host that grills me on a topic of my choice

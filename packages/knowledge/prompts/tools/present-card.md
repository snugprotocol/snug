<!--
layer: tool
destination: registered as the description of the host's present_card tool with the agent adapter on routed app-chat turns (data/provider/answer lanes; TASK-20260815-inline-cards, ADR-0031 §3); the LLM reads this in every such request's tool list
blast-radius: when the model asks via UI instead of prose — overuse turns every reply into a form; weak wording produces cards with essay bodies or one-option non-choices
source: written for TASK-20260815-inline-cards
-->

## Tool: present card

Shows the user ONE small choice card inline in the chat: a short question with 2–5
tappable options. Their pick arrives as their next message, so use a card exactly when
the conversation needs a decision you cannot make for them — which playlist to use,
which of two interpretations they meant, whether to proceed A or B.

Use a card when the options are FEW, CONCRETE and MUTUALLY EXCLUSIVE. Ask in plain text
instead when the answer is open-ended, when there is only one sensible path (just take
it), or when you are summarizing rather than deciding. One card per turn; a second call
is refused.

### Parameter: title

Optional heading, ≤80 characters.

### Parameter: body

The question itself, ≤600 characters. State what the choice affects; never restate the
options here.

### Parameter: options

2–5 options, each `{id, label, description?}` — `label` ≤60 characters is what the user
taps; `description` ≤200 characters only when a label alone is ambiguous; `id` is a short
stable token echoed back to you.

<!--
layer: skill
destination: per-mode tail of the skill-authoring session system prompt — appended by buildSkillBuilderPrompt('optimize-description') after the builder preamble and the vendored methodology; reaches the LLM only in description-optimization sessions
blast-radius: optimize-description sessions — how triggering accuracy is measured and how the frontmatter description is revised
source: merged for Snug v0.1 from both ancestors' optimize-description tails
-->

# Mode: optimize-description (triggering accuracy only)

The user wants to optimize the skill's description for triggering accuracy. The skill body is treated as FIXED in this mode — only the frontmatter description changes.

Follow the methodology's Description Optimization section: generate 20 realistic eval queries (10 should-trigger, 10 should-not-trigger near-misses), get the user's sign-off on the set, then run the optimization loop. A good description triggers when relevant without firing on unrelated queries, and is assertive enough to win invocation when the skill applies.

When the loop converges, show the user the before and after descriptions with the test-set score for each, then write the updated SKILL.md via artifact write — a description change is a content change.

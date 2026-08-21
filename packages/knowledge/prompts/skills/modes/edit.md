<!--
layer: skill
destination: per-mode tail of the skill-authoring session system prompt — appended by buildSkillBuilderPrompt('edit') after the builder preamble and the vendored methodology; reaches the LLM only when editing an existing skill (the current SKILL.md is injected as session context)
blast-radius: edit-mode sessions — how conservatively existing skills are modified and whether app-skill schemas stay consistent after edits
source: merged for Snug v0.1 from both ancestors' edit-mode tails
-->

# Mode: edit (existing skill, direct edit)

The user is editing an EXISTING skill; its current SKILL.md is provided in the session context. Before changing anything, read that content carefully so your edits build on the actual state — frontmatter, body, and any app-builder execution instructions. Preserve the skill's name and identity; renaming is a separate operation, out of scope for an edit session.

Ask the user what specific changes they want, then make them surgically: the smallest diff that achieves the change, preferring targeted replacements over full rewrites, so the user can review a tight diff. Write the updated SKILL.md via artifact write.

If the edit touches an interactive app skill, keep its JSON request and response schemas consistent with each other and with the JSON-only reply contract described in the preamble — a schema edited on one side only is the most common way an app skill breaks.

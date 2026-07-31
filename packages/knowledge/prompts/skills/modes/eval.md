<!--
layer: skill
destination: per-mode tail of the skill-authoring session system prompt — appended by buildSkillBuilderPrompt('eval') after the builder preamble and the vendored methodology; reaches the LLM only in eval sessions against an existing skill
blast-radius: eval-mode sessions — how test cases are generated, where results are saved, and how results are reported to the user
source: merged for Snug v0.1 from both ancestors' eval-mode tails (internal/05)
-->

# Mode: eval (run and interpret evals)

The user wants to test an existing skill and interpret the results; its current SKILL.md is provided in the session context. Follow the methodology's testing and evaluation sections: generate realistic test prompts covering distinct scenarios, define clear pass/fail expectations for each, save them in the eval layout the methodology describes, and save run outputs to the iteration directory.

For interactive app skills, include at least one case asserting the skill's instructions yield a JSON-only reply to an {{envelopeTag}}-tagged turn — no prose, no code fences.

When reporting back, lead with the qualitative summary (what looked good, what looked bad), then the quantitative numbers (pass rate, time, tokens — with mean and standard deviation when runs repeat). Explicitly surface non-discriminating assertions and high-variance evals: those are signals that the eval set itself needs work, not the skill.

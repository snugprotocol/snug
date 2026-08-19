# Requirements

Owner requirements, restated as musts (from prompts 01 + 02 and the interview):

1. Must consolidate EVERY connected bank/credit-card account via one SimpleFIN
   connection into the app's own tables in the user's file — balances, transactions,
   pending state, history.
2. Must answer arbitrary budget/expense/income questions from that data (ask lane),
   grounded and cited, never invented.
3. Must strategize and plan: a stated goal becomes concrete monthly steps against real
   spending, and a saved plan becomes a visible branch on the trajectory chart.
4. Must render "ultra cool" visuals of where the user is and where they could be — the
   time machine with a 3–36 month scrubber, cash flow, category bars, spend heatmap.
5. Must surface redundant expenses — especially subscriptions — clearly: overlap,
   price creep, lapse flags, ranked verdicts, monthly cost.
6. Must help act on them: cancellation guidance with the merchant's own site opened by
   the host on user confirmation (open-url capability, Phase C), the user signing in
   themselves — merchant credentials never touch Snug.
7. Must verify outcomes from the data: a marked cancellation is confirmed by the
   absence of the next charge, with a running savings tally.
8. SimpleFIN must be a registered provider with a layman-grade wizard walkthrough, so
   any user-authored app gets the same consistent auth flow.
9. Must be fully usable with no LLM configured (ADR-0011) and instantly compelling
   with no connection (sample mode with planted leaks).
10. Must persist its authoring provenance (these documents and the verbatim prompts)
    into the installed app's wiki (ADR-0035).

Hard boundaries: no sidecar (plain HTTPS + CORS suffices); no agentic form-filling on
merchant sites; the setup token is consumed once and never stored; sample rows are
provenance-flagged and evicted wholesale by the first real sync.

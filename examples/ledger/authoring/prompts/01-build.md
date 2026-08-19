# Build prompt — Ledger

- **Date:** 2026-08-18
- **Task:** TASK-20260818-ledger-starter (ADR-0038)
- **Model:** Claude Fable 5 (conductor), via Claude Code
- **Supersedes:** nothing — first prompt of this app

The owner's prompt, verbatim and unedited:

---

I would like to build another starter app - which is an unique never seen before Mint
like app.  This starter app should be more complementary to apps like mint where it is
user owned and can help user to query any budget/expenses/income/finance related
queries from all the connected bank accounts/credit cards, help them strategize, plan
based on their needs and expected outcome, give them ultra cool visuals on where they
are and where they can be in a given time if they follow certain recommendations by
the LLM.  more than a clone of mint this app should be 10 steps ahead of Mint with an
ultracool super intuitive UI/UX .  I want you to be super creative, think out of the
box and also add any features you think will be value add given the context,
possibilities and create the ultimate WOW factor .

Like any starter app (whatsapp/telepath and others) this app should also persist the
build prompt, lessons, plan, vision, requirements, etc

I'm considering to integrate SimpleFIN for this app.  SimpleFIN should be registered
in the auth connetion (and wizard guiding the user which a layman can easily follow,
click on links, register dev account with SuperFIN if not yet and authenticate thru
it), so this starter app and any custom authored user app can leverage it and have a
consistent auth flow via the wizard.  For the starter app I want you to determine if
we should take the sidecar approach similar to whatsapp or directly connect from the
app itself ? Please remember than SimpleFIN auth will be the first step for the user
installing this app or similar apps.  Subsequently the user would need to connect with
any bank accounts they wish via SimpleFin but all within the app.  The app should then
be able to fetch data from any and every bank/credit card accounts connected and then
consolidate at its end , save it in the snug db and then user can run analysis on it
and get some interesting insights and intelligence

---

## Interview answers that shaped the build (2026-08-18)

- **Platform:** web + desktop (live probes confirmed the SimpleFIN bridge serves CORS,
  so browser-direct connected-fetch works — no sidecar, ADR-0038 D1).
- **Name:** Ledger.
- **Demo:** bundled deterministic sample data, usable the moment it is installed.
- **LLM depth:** full in-app agent lanes (runtime contract), on top of dashboards that
  stay deterministic (ADR-0011).

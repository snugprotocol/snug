# Build prompt — Telepath (verbatim)

The owner's prompt that drove this rebuild, recorded verbatim (ADR-0031 provenance; seeded
into `snug_app_docs` as the `build-prompt` slug at install, ADR-0035).

- **Date:** 2026-08-17
- **Task:** TASK-20260817-telepath
- **Model:** Claude Fable 5, via Claude Code `/start-task`
- **Supersedes:** the WhatsApp Twin build prompt (TASK-20260816-whatsapp-twin), in git history

---

Rebuild an awseome, ultra cool Whatsapp twin starter app.
The current  app is working as I described and the intent was POC .  Now I want you to a highly inituitive, value add, one of its kind .
In the current app I loved the connection wizard which worked smoothly.  So the new one too should leverage the same which I believe is already part of the registry and not separate.
The psychological analysis and overall analysis done by the app was really good and I want you to retain that feature in the new app.  The UI/UX of the new app will be different as follows:

1. On opening of the app which already has the auth connection established, the landing page of app should show similar UI/UX as the official version of whatsapp on iOS where you see all recent conversation, can click on any and see the conversation thread loaded with recent messages (including media) .  For the first version you can just show pictures and exclude other medias like voice, video, etc.  

2.  In the current version the chat participation names are anonymized .  Now I want you to show exactly the same names/numbers as you see on whatsapp.  When sending conversation to LLMs for analysis convert every unique name/number to an uniq temp identifier and when you get the final response back from LLM then covert them back to the name/number on the app side .  so this way name/number never gets exposed to the LLM and the end user can see all info which he already has acccess & visibility to on the original whatsapp.  Maintain the mapping correctly on the app side so that you can map it back when needed.

3.  Sort/Order messages in the thread and the main landing page by recent messages (same like whatsapp) .  New messages coming in should show immediately and badge count should be updated for every chat window.  basically so far you are creating a clone of whatsapp with message sending/responding capability.  The addition to this will be the new icon button near (the message input textbox where user yypes messages to be sent) for draft from AI where the AI will draft the most logical and natural response on behalf of the user with his language tone and emotions.  use emojis based on the context and usage frequency from the user based on historical conversation.

4.  On the conversation thread window , show the new analyze icon button which when clicked the first time should run the complete in-depth analysis similar to what you did in the current app .  you can reuse the same knowledge base prompt you send to the LLM .  however in the current app user is expected to upload the exported file, here in this new version I want you to implicity do that by calling the export feature (without meia) of whatspp from the app, fetch the output, mark the most recent date time of the most recent message and mark this dateime with export action completed and then run the same analyzes via LLM.  On subequent request fetch the analysis from last time (which should have been saved in db) pull all the recent messages since last time the analysis was done, and ask the llm to reanalyze based on last time's output and the delta of new messages.  Also make sure the analysis you show in the app for each person has their proper name/number as shown by the whatsapp message without anonymyzing them.  

5.  make sure the needed sidecar is always up and running on the app load

6.  The analyze action of a conversation thread should also produce charts ( a new chart tab) which shows some interesting analysis like a pie chart showing activity based on number of messages from every user in that conversation,  timing trend showing every users (all participants of that conversation thread)  message sending activity based on time and week days and some interesting charts which you can think of

7.  Remove the auto respond feature in this version

8.  Generate all the vision, requirements,plan, vision, wiki docs and save them in the db 

9.  Save the prompt which drove the app building in the db too

10., Name the app to - "Smart whatsapp" or something cool you can suggest.


Oerall build a genuine value add whatsapp which will significantly raise the benchmark for any personal messaging service and wow anyone with the potential and possibilities the snug protocol has

---

## Interview answers that shaped the build (2026-08-17)

Four questions were asked before planning; the owner's answers:

- **The POC's fate:** replace WhatsApp Twin in place (same folder, same registry entry,
  same connection) — ADR-0027 distill-don't-accumulate.
- **The name:** **Telepath** ("knows what you'd say next") — chosen over "Smart WhatsApp",
  which would put another company's trademark in our own app's display name.
- **Live updates:** a TRUE push seam, not app polling — which became the sidecar hint
  stream plus the host live pump (ADR-0034).
- **Media scope:** images AND avatars in v1.

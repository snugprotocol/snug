# Lessons — Inbox Copilot

- **A provider entry can be present and still unusable.** Gmail had correct endpoints,
  hosts, PKCE and redirect posture, and connecting was still impossible: no scopes meant
  a token that reads nothing, no `fields` meant a credential screen with no inputs. The
  repo's own next-steps had recorded the dead-end; nothing failed, because nothing tested
  that an entry was *sufficient* rather than merely present. Completeness needs its own
  assertion.

- **Probe the provider before writing the walkthrough.** Google documents
  `client_secret` as "Optional" for installed apps; the token endpoint refuses the
  exchange without it. Copying Spotify's honest "PKCE needs no secret" sentence onto
  Google would have shipped a wizard that completes consent and then dies at the
  exchange — with copy telling the user the field they need does not exist.

- **Withholding a permission is a design mechanism, not just hygiene.** Not requesting
  `https://mail.google.com/` is what makes "this app never deletes your mail" a property
  of the token rather than a promise in the code. A capability the app asks for and
  pledges not to use is the mirror image of the harm scope-pinning exists to prevent.

- **The confirm copy and the request body must be the same object.** Building the
  preview text separately from the API call is how a UI ends up promising one thing and
  doing another after a later edit. Making the plan a single value that renders *and*
  executes removes the drift by construction.

- **The exclusions are the feature.** Counting mail is arithmetic; knowing that a
  receipt and a starred newsletter are not cleanup candidates — despite looking exactly
  like noise statistically — is what makes the recommendations safe to act on. Both
  exclusions have their own tests and both appear in the sample data, because a demo
  that only shows the easy cases is not showing the judgment.

- **The linter caught a URL inside a comment.** The single-file scan flags any
  external-looking URL, including a phishing example written to explain the URL gate.
  Reword the illustration; do not weaken the scan.

- **The shipped contract suite cannot tell you the app never boots.** Every gate was
  green while the app sat on its loading skeleton forever: the readiness check read
  `app.ready`, and the hook returns `isReady`. A typo'd property on an object is
  `undefined`, not an error, so nothing failed — not the validator, not the extracted-core
  suite, which by design evaluates only the pure region and never renders. Ten minutes in
  a real browser with a stub host found it immediately. Render the app before calling it
  done; a starter whose first screen is a skeleton is worse than no starter.

- **A legend must describe a colour something on screen is wearing.** The sender bars
  coloured replied-to correspondents green — and the top seven by volume were all
  broadcasters, so the legend explained a colour the chart never showed. Ranking now
  reserves a slot for the loudest sender the user actually answers, which is also the
  contrast the chart exists to draw.

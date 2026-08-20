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

- **A bridge error is an object, so `error || 'fallback'` prints "[object Object]".** The
  app recovered from a refused sync exactly as designed and then described the failure
  uselessly — replacing the one thing the user needs (what went wrong, and whether
  retrying helps) with noise, at the moment they are wondering whether their mail is
  safe. Six call sites had it. The unit test for the formatter would not have caught it,
  because the defect was in the CALL SITES; the regression guard is a source sweep for
  `.error ||` in the authored region.

- **A demo harness that stays silent is not a stand-in for a host that always answers.**
  The stub used for the browser pass ignored `snug:net-request`, so the app hung on
  "reading 0" and looked wedged. The real host always posts a terminal frame — success or
  a `NET_*` error — so the hang was pure harness artifact and nearly sent me looking for a
  timeout bug in shipping code. A stub must reproduce the contract's GUARANTEES, not just
  its happy path, or it manufactures failures that do not exist.

- **The axis has to follow the query.** Making Refresh window-selectable silently left a
  hardcoded "Twelve weeks of arrivals" caption and a 12-bucket chart, so a one-week pull
  would have drawn eleven empty columns — a collapse the data never showed, told by the
  axis. Any control that changes how much data is fetched has to be traced through
  everything that describes the amount.

- **An app that keeps its data in React state does not keep it.** Inbox Copilot shipped
  with no `useAppDB` call at all: every synced message lived in the component and died
  with the frame, so closing the app threw the whole mailbox away and the next launch
  fell back to the demo. Nothing caught it because the suites test pure functions and the
  browser pass never relaunched — the one action that exposes it. On a platform whose
  premise is that the user owns their data in a portable file (ADR-0007), "did this
  survive a close?" belongs in the verification of any app that fetches anything.

- **Derive "is this the demo?" from the DATA, never from a session phase.** The flip had
  two causes and the second outlived the first fix: `isSample` read a sync phase that
  starts idle on every launch, and `connected` did the same — so even after rows loaded
  correctly from the file, a returning user was told "Sample inbox, connect Gmail". Row
  provenance (Ledger's `sample` column, ADR-0038) survives a relaunch by construction;
  a phase cannot.

- **Zero results are never worth committing.** A refused or throttled sync returning no
  messages would, written naively, delete a real mailbox out of the user's own file and
  silently revert them to the demo next launch — a transient failure turned permanent.
  The commit gate is explicit and tested, and a failed sync now writes only its
  `sync_runs` row.

# Vision — Inbox Copilot

**A person's inbox is a relationship map they have never been shown.**

Every mail client sorts by time, because time is the one thing it knows for certain.
The result is that the loudest sender and the closest friend arrive in the same column,
and the only tool for telling them apart is the reader's own memory. People cope by
declaring bankruptcy every few years, or by never coping at all.

Inbox Copilot shows the shape instead of the stream. Ninety days of metadata is enough
to answer questions nobody can answer by scrolling: who actually fills this inbox, which
of them has ever heard back, what proportion of the arriving volume is from senders the
person has silently ignored for months. Those answers are not interesting on their own —
they are interesting because each one has an action attached, and the action can run on
thousands of messages at once.

**The judgment is the product.** Counting emails is trivial; knowing that a bank's
receipts and a starred newsletter are *not* candidates for cleanup — despite matching
every statistical signature of noise — is the part that makes the recommendations
trustworthy. An app that flags a person's pharmacy as ignorable gets uninstalled after
one wrong suggestion, however good its charts are.

**Trust is designed in, not asserted.** The app operates on someone's real mail, so its
safety cannot rest on good intentions in the code. It rests on what the granted token
can and cannot do: no scope that permits permanent deletion, so "nothing is ever
deleted" is a structural fact rather than a claim. Above that sits a preview that names
the exact count and senders, and above that the host's own confirmation.

**Why this belongs on Snug.** The app never holds a credential, never sees a token, and
can reach exactly one host. A person can read the whole thing in an afternoon. That is
the argument: the most invasive category of app — bulk operations on private
correspondence — is also the one where a user-owned, sandboxed, single-file app has the
most to offer over a service asking them to trust a privacy policy.

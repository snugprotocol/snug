// ChatgptPlanRows — Settings' "my ChatGPT plan" card (TASK-20261023-siwc-chatgpt-plan plan §3 L5,
// §12 L5-1 + amendments; ADR-0078 §5–§7, §9). Rendered under "where the agent runs" when the mode is
// `chatgpt`; the segment click already chose the mode, so nothing here sets it.
//
// Three states, one card, each with the acts a person can take there (lesson L449):
//   SIGNED OUT — "Continue with ChatGPT" (no consent prompt); while the browser is open, the awaiting
//     hint and a primary **cancel this sign-in** (the wizard's precedent; AC2); the consent band says
//     *preview*, carries the D9 data-use sentence from its one non-legal home, and says where the
//     sign-in lives — outside the passphrase-protected file (D2). A kept registration offers
//     **forget this registration** — the way out when a ChatGPT-side disconnect deleted the client
//     (D10, AC9); nothing registered → nothing to forget.
//   SIGNED IN, PLAN GRANTED — the account, *Using ChatGPT plan* + Manage usage (OpenAI's required
//     indicator), the default model over the ACCOUNT's models in server order (D6), the level only
//     when the chosen model has levels (ADR-0070's Haiku rule), **Sign out of ChatGPT** → the pointer
//     to ChatGPT → Settings, and a sentence when the revocation was not confirmed (D7: never claim a
//     revocation that did not happen).
//   SIGNED IN, PLAN NOT GRANTED — **allow plan usage** (`prompt=consent`) and the alternatives named.
//
// No `console.*`: a status or a failure sentence here can sit beside a token.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { CHATGPT_ERROR_CODES, CHATGPT_ERROR_SENTENCES } from '@snugprotocol/adapters';

import { CHATGPT_DATA_USE } from '../access/copy.js';
import { ChatgptButton } from '../desktop/ChatgptButton.js';
import { ChatgptSignInWait } from '../desktop/ChatgptSignInWait.js';
import {
  chatgptModelView,
  forgetChatgptRegistration,
  refreshChatgptModels,
  signInToChatgpt,
  signOutOfChatgpt,
  useChatgptPlan,
  useChatgptSignInPending,
} from '../state/chatgptPlan.js';
import { setChatgptEffort, setChatgptModel, useChatgptEffort, useChatgptModel } from '../state/mode.js';
import { Button } from '../ui/Button.js';
import { CHATGPT_DEFAULT_CHOICE, ChatgptModelOptions } from '../ui/ChatgptModelOptions.js';
import { ManageUsageLink } from '../ui/ManageUsageLink.js';
import { UsageLimitMessage } from '../ui/UsageLimitMessage.js';

/** D7: sign-out is local + best-effort revocation; the account-side disconnect is ChatGPT's to do. */
export const DISCONNECT_POINTER = 'to remove Snug from your account entirely, disconnect it in ChatGPT → Settings.';

type Revocation = 'confirmed' | 'unconfirmed' | 'none';

export function ChatgptPlanRows(): ReactElement {
  const plan = useChatgptPlan();
  const pending = useChatgptSignInPending();
  const model = useChatgptModel();
  const effort = useChatgptEffort();
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [signedOut, setSignedOut] = useState<Revocation | undefined>(undefined);

  // AC8: the account's model list is refreshed on Settings open (the keeper fails soft to its last list).
  useEffect(() => {
    void refreshChatgptModels();
  }, []);

  const signIn = (opts?: { prompt: 'consent' }): void => {
    setFailure(undefined);
    setSignedOut(undefined);
    void signInToChatgpt(opts).then((result) => {
      if (!result.ok) setFailure(result.message);
    });
  };

  const signOut = (): void => {
    setFailure(undefined);
    void signOutOfChatgpt().then(({ revocation }) => setSignedOut(revocation));
  };

  const failureNote =
    failure !== undefined ? (
      <p className="error-note" role="alert" data-testid="chatgpt-sign-in-failure">
        {failure}
      </p>
    ) : null;

  // The sign-out's outcome (D7), in whichever state the keeper lands: the local sign-out is done, the
  // account-side disconnect is ChatGPT's — and a revocation that was not confirmed is SAID, never claimed.
  const signedOutNote =
    signedOut !== undefined ? (
      <>
        <span className="hint" data-testid="chatgpt-signed-out">
          signed out of ChatGPT on this computer. {DISCONNECT_POINTER}
        </span>
        {signedOut === 'unconfirmed' ? (
          <span className="hint" data-testid="chatgpt-revocation-unconfirmed">
            ChatGPT did not confirm that the sign-in was revoked — it may still list Snug until you disconnect it there.
          </span>
        ) : null}
      </>
    ) : null;

  // ---- SIGNED OUT (or the first store read still pending) ----
  if (plan === 'unknown' || !plan.signedIn) {
    return (
      <div className="field settings-row" data-testid="chatgpt-plan-rows">
        <label>account</label>
        {pending ? <ChatgptSignInWait /> : <ChatgptButton onClick={() => signIn()} />}
        {failureNote}
        {signedOutNote}
        {/* THE CONSENT BAND (D9; the BYOK band's precedent): what the feature is, where the requests go,
            and where the sign-in lives. The data-use sentence is the ONE non-legal home's, never retyped. */}
        <div className="hint" role="note" data-testid="chatgpt-consent-band">
          ChatGPT plan usage in Snug is a preview. {CHATGPT_DATA_USE} Your ChatGPT sign-in is kept on this computer,
          outside the passphrase-protected file — it never rides exports or sync. Signing out deletes its tokens; the
          registration this computer made with ChatGPT (an app id, not a credential) stays until you choose &ldquo;forget
          this registration&rdquo;.
        </div>
        {plan !== 'unknown' && plan.registered ? (
          <>
            <span className="hint">
              if ChatGPT no longer lists Snug, forget what this computer registered so the next sign-in starts fresh.
            </span>
            <Button variant="ghost" onClick={() => void forgetChatgptRegistration()}>
              forget this registration
            </Button>
          </>
        ) : null}
      </div>
    );
  }

  const account = plan.email ?? 'your ChatGPT account';

  // ---- SIGNED IN, PLAN NOT GRANTED (ADR-0078 §5: kept as signed-in-with-plan-disabled) ----
  if (!plan.planGranted) {
    return (
      <div className="field settings-row" data-testid="chatgpt-plan-rows">
        <div className="provider-row-head">
          <label>account</label>
          <span className="chip provider-key-chip" data-testid="chatgpt-plan-state">
            plan not allowed
          </span>
        </div>
        <span className="hint">
          signed in as {account}, but ChatGPT plan usage isn&apos;t allowed for Snug yet — allow it to run your apps on
          your plan, or use a key or a local model instead.
        </span>
        {pending ? (
          <ChatgptSignInWait />
        ) : (
          <Button variant="primary" onClick={() => signIn({ prompt: 'consent' })}>
            allow plan usage
          </Button>
        )}
        <div className="field-row">
          <Button onClick={signOut}>Sign out of ChatGPT</Button>
        </div>
        {failureNote}
        {signedOutNote}
      </div>
    );
  }

  // ---- SIGNED IN, PLAN GRANTED ----
  // The ONE model derivation (ST2): the account's models, the default (the plan's own row, else the
  // account list's first — appModel.ts), the resolved model and its levels.
  const view = chatgptModelView(plan, model);
  const { models, resolved, levels } = view;
  const unlistedLevel = effort !== undefined && !levels.includes(effort);

  return (
    <div className="field settings-row" data-testid="chatgpt-plan-rows">
      <div className="provider-row-head">
        <label htmlFor="chatgpt-model-select">account</label>
        <span className="chip provider-key-chip is-set" data-testid="chatgpt-plan-state">
          Using ChatGPT plan
        </span>
      </div>
      <span className="hint" data-testid="chatgpt-account">
        {account} · <ManageUsageLink />
      </span>
      {plan.limit !== undefined ? (
        plan.limit.code === 'usage_limit' ? (
          <UsageLimitMessage testId="chatgpt-settings-usage-limit" />
        ) : (
          <span className="hint">{CHATGPT_ERROR_SENTENCES[CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE]}</span>
        )
      ) : null}
      {models.length > 0 || model !== undefined ? (
        <div className="provider-model-row">
          <label htmlFor="chatgpt-model-select" className="provider-model-label">
            default model
          </label>
          {/* The ACCOUNT's models, server order, display names (D6) — never a catalogue of ours; the one option list (ST2). */}
          <select
            id="chatgpt-model-select"
            data-testid="chatgpt-model-select"
            value={model ?? CHATGPT_DEFAULT_CHOICE}
            onChange={(event) => setChatgptModel(event.target.value === CHATGPT_DEFAULT_CHOICE ? undefined : event.target.value)}
          >
            <ChatgptModelOptions view={view} value={model ?? CHATGPT_DEFAULT_CHOICE} />
          </select>
        </div>
      ) : null}
      {levels.length > 0 ? (
        // Only when the chosen model HAS levels (ADR-0070's Haiku rule): a control the model ignores is a dead control.
        <div className="provider-model-row">
          <label htmlFor="chatgpt-effort-select" className="provider-model-label">
            thinking level
          </label>
          <select
            id="chatgpt-effort-select"
            data-testid="chatgpt-effort-select"
            value={effort ?? ''}
            onChange={(event) => setChatgptEffort(event.target.value === '' ? undefined : event.target.value)}
          >
            <option value="">default{resolved?.defaultEffort !== undefined ? ` (${resolved.defaultEffort})` : ''}</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
            {unlistedLevel ? <option value={effort}>{effort} (not offered by this model)</option> : null}
          </select>
        </div>
      ) : null}
      <span className="hint">
        requests go from this computer to OpenAI under your ChatGPT account — no API key involved. the sign-in is kept on
        this computer, outside your file.
      </span>
      <div className="field-row">
        <Button onClick={signOut}>Sign out of ChatGPT</Button>
      </div>
      {failureNote}
      {signedOutNote}
    </div>
  );
}

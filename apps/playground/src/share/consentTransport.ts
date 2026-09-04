// consentTransport.ts — the LLM transport a SHARED PREVIEW runs with (finding 2,
// ADR-0063 §4). A stranger's code must not spend the user's tokens on a click: until
// the user arms "run with AI" in the preview header, every `llm-request` the app sends
// is answered with a named, non-retryable refusal — errors are data in the envelope
// contract, so the app renders the refusal instead of hanging. A starter keeps the
// real transport (the pillar demo is the point); a shared preview does not.

import { ERROR_CODES } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';

export const SHARED_PREVIEW_CONSENT_MESSAGE =
  'this is a preview of a shared app — press "run with AI" in the header to let it use your AI, or install it';

export function createConsentGateTransport(): AgentTransport {
  return {
    send: async () => ({
      ok: false,
      code: ERROR_CODES.CONSENT_REQUIRED,
      message: SHARED_PREVIEW_CONSENT_MESSAGE,
      retryable: false,
    }),
  };
}

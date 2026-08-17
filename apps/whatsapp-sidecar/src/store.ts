/**
 * THE SIDECAR'S OWN STORE (ADR-0032 §2) — the access token, the mint counter, and the
 * WhatsApp auth state.
 *
 * THE CUSTODY SPLIT IS THE WHOLE POINT. Two different secrets live here and they have
 * opposite exposure rules:
 *
 *  - the ACCESS TOKEN is a key to THIS HELPER. It is minted once at pairing and handed to
 *    the wizard, which stores it in `snug_secrets`. It crosses the wire exactly once, on
 *    the poll that releases it.
 *  - the WHATSAPP AUTH STATE (noise keys, identity keys, signed pre-keys, session records)
 *    is a key to the USER'S ACCOUNT. It never crosses the wire at all — not scrubbed, not
 *    redacted: never serialized into a response in the first place. That is what makes
 *    C1's claim true rather than aspirational: compromising everything Snug stores yields
 *    a key to a helper, not the user's WhatsApp.
 *
 * The in-memory implementation below is what the suite runs against. The disk-backed one
 * (Baileys' `useMultiFileAuthState` over `~/Snug/whatsapp-sidecar/`) implements the same
 * interface; the router never learns which it has.
 */

/** Opaque to this module — only the WhatsApp adapter interprets it. */
export type WaAuthState = Record<string, unknown>;

export interface SidecarStore {
  /** The minted access token, or undefined before pairing completes. */
  token(): string | undefined;
  /** Record the token. Refuses to overwrite: one link, one token. */
  setToken(token: string): void;
  /** How many times a token has been minted — pinned by test at exactly 1 per link. */
  mintCount(): number;
  getAuthState(): WaAuthState | undefined;
  setAuthState(state: WaAuthState): void;
}

export function createMemoryStore(): SidecarStore {
  let token: string | undefined;
  let mints = 0;
  let auth: WaAuthState | undefined;
  return {
    token: () => token,
    setToken(next) {
      // NOT an overwrite. A store that re-assigns on every poll would hand a fresh secret
      // to each caller and silently invalidate the wizard's copy behind its back.
      if (token !== undefined) return;
      token = next;
      mints += 1;
    },
    mintCount: () => mints,
    getAuthState: () => auth,
    setAuthState(state) {
      auth = state;
    },
  };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * A store whose TOKEN survives a restart.
 *
 * The helper is a spawn-supervised child: it stops when the desktop app closes and restarts
 * on demand. With a memory-only token that meant every restart minted a new secret while the
 * host still held the old one — the connection stored perfectly and refused permanently
 * ("the helper refused that key"). The session keys already persist beside this; the access
 * token is the same class of fact and belongs with them.
 *
 * The auth state stays in memory here: Baileys owns its own on-disk store through
 * `useMultiFileAuthState`, and a second copy would be a second source of truth.
 */
export function createFileStore(dir: string): SidecarStore {
  const tokenFile = join(dir, 'access-token.json');

  const read = (): string | undefined => {
    try {
      if (!existsSync(tokenFile)) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(tokenFile, 'utf8'));
      const value = (parsed as { token?: unknown } | null)?.token;
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    } catch {
      // A corrupt or truncated file (power loss mid-pairing) reports NO token rather than
      // throwing: that sends the user back through linking, which works. Wedging the helper
      // on a malformed byte would not.
      return undefined;
    }
  };

  let mints = 0;
  let auth: WaAuthState | undefined;

  return {
    token: read,
    setToken(next) {
      // The same no-overwrite rule the memory store states, now across processes: a store
      // that re-assigned would hand a fresh secret to each caller and silently invalidate
      // the host's copy behind its back.
      if (read() !== undefined) return;
      try {
        mkdirSync(dir, { recursive: true });
        // 0600 because this IS the credential: anything that can read it can drive the
        // user's WhatsApp. Written with the mode set at creation, not chmod-ed after, so
        // there is no window in which it exists world-readable.
        writeFileSync(tokenFile, JSON.stringify({ token: next }), { mode: 0o600 });
        mints += 1;
      } catch {
        // Nothing to do but leave the token unset; the wizard's verify read will fail and
        // tell the user to link again rather than claiming a connection that cannot work.
      }
    },
    mintCount: () => mints,
    getAuthState: () => auth,
    setAuthState(state) {
      auth = state;
    },
  };
}

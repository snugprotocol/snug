// starterLooks.ts — each starter's presentation: emoji, color, blurb and the name the app
// calls itself. Moved out of HubView (TASK-20261003 S3) because the run route now needs it
// too: a starter this host cannot run never mounts its frame, so it never announces, and the
// "can't run here" panel would otherwise show a folder name and a hexagon for an app the
// shelf one click earlier called Moodboard.
//
// PRESENTATION ONLY. Whether a starter runs on this host is NOT in this table — it used to
// be (a `desktopOnly` flag here, read against `kind !== 'desktop'`), with one reason string
// that was true for one of the three starters it locked. That is derived now, from the
// connection each starter declares (`platform/availability.ts`).

export interface StarterLook {
  emoji: string;
  color: string;
  blurb: string;
  /** The display name the tile shows. Absent → the folder, which is honest rather than guessed. */
  name?: string;
}

/**
 * Keyed by FOLDER — which stays the identity (`install_source`, the availability verdict and
 * the tile's `data-starter-name` all key on it). `name` is the optional display name the tile
 * shows: `listStarterApps()` derives its label from the folder, so without this the shelf read
 * "whatsapp" for Telepath, "spotify" for Rewind, "hue" for Moodboard. That is not a cosmetic
 * gap — after the WhatsApp starter was rebuilt into Telepath the shelf looked completely
 * unchanged, which is indistinguishable from "the rebuild did not land" (owner-reported,
 * 2026-08-17). A folder with no `name` falls back to the folder, which is honest rather than
 * guessed.
 */
export const STARTER_LOOKS: Readonly<Record<string, StarterLook>> = {
  // The keepers (owner curation, TASK-20260815-starter-apps-rebuild).
  chess: { emoji: '♞', color: '#8b5cf6', blurb: 'play an opponent with opinions — no server needed' },
  'flying-pig': { emoji: '🐷', color: '#ec4899', blurb: 'tap to keep a pig airborne — pure offline arcade' },
  'adventure-quest': { emoji: '🐉', color: '#7c3aed', blurb: 'the agent tells the tale — your pack lives in a real file' },
  'quiz-me': { emoji: '🧠', color: '#0284c7', blurb: 'pick any topic, take a five-question quiz, watch scores climb' },
  // The gold-standard connected five (TASK-20260815-starter-apps-rebuild, ADR-0031):
  // each complements its provider's own app rather than cloning it, and each teaches
  // the provider chat lane.
  'trade-copilot': { name: 'Trade Copilot', emoji: '📈', color: '#f59e0b', blurb: 'a copilot grounded in your real Coinbase portfolio — it thinks, you decide' },
  spotify: { name: 'Rewind', emoji: '🎧', color: '#10b981', blurb: 'your listening, understood — portraits and trends Spotify forgets' },
  hue: { name: 'Moodboard', emoji: '🌗', color: '#e11d48', blurb: 'light as mood — the agent is your lighting designer' },
  weather: { name: 'Should I?', emoji: '🌦️', color: '#3b82f6', blurb: 'forecasts turned into decisions — run, ride, water, or wait' },
  github: { name: 'Standup', emoji: '🗞️', color: '#64748b', blurb: 'what needs you today, before you ask — your queue as a briefing' },
  // The linked-device starter (Telepath, TASK-20260817 rebuild of the Twin; ADR-0032/0034).
  whatsapp: { name: 'Telepath', emoji: '🔮', color: '#0f7d61', blurb: 'your WhatsApp, live — with an analyst who knows the room and drafts in your voice' },
  // The personal-finance flagship (TASK-20260818-ledger-starter, ADR-0038). The sample
  // dataset makes the tile compelling before any connection exists.
  ledger: { name: 'Ledger', emoji: '📒', color: '#b95c22', blurb: 'your money, at home — every account in your file, an analyst on tap, a time machine for your net worth' },
  // The AI inbox manager (TASK-20260819-gmail-starter, ADR-0039).
  gmail: { name: 'Inbox Copilot', emoji: '📬', color: '#c2410c', blurb: 'who is really filling your inbox, who you never answer, and a mass cleanup you approve once' },
};

const FALLBACK_LOOK: StarterLook = { emoji: '⬡', color: 'var(--ember)', blurb: 'curated example — runs without a server' };

/** A starter's look by folder; a folder with no row gets the generic hexagon and blurb. */
export function starterLook(folder: string): StarterLook {
  return STARTER_LOOKS[folder] ?? FALLBACK_LOOK;
}

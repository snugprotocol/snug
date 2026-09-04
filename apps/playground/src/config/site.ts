// The public website, single-homed for the playground/desktop shell.
//
// Dependency direction (ADR-0048): website → playground, never the reverse — the
// website imports our releaseChannel.ts through its `@playground` alias, so this
// constant is playground-OWNED and deliberately not shared back. Any new surface
// linking to the site must import this, not respell the domain.
export const WEBSITE_URL = 'https://snugprotocol.org';

// The reference repo, single-homed for the feedback deep links (ADR-0052): the
// in-product "report this" / feedback affordances assemble prefilled GitHub URLs —
// no hosted receiver exists, GitHub IS the feedback channel. While the repo is
// private these 404 for non-collaborators (the /download designed-quiet state,
// ADR-0047); they go live at flip-public with no code change.
export const REPO_URL = 'https://github.com/snugprotocol/snug';
export const REPO_NEW_ISSUE_URL = `${REPO_URL}/issues/new`;
export const REPO_DISCUSSIONS_URL = `${REPO_URL}/discussions`;

// The share relay (ADR-0064) — the ONE hosted endpoint, content-blind. Single-homed
// here so the share sheet, the link receiver and the desktop deep-link handler agree
// on the origin; EMPTY means "no relay": the copy-link action does not render and the
// attachment path carries sharing alone (self-hosters, and every build until the
// relay is deployed on an explicit owner ask). Set at build time only.
export const SHARE_RELAY_ORIGIN: string = (import.meta.env?.VITE_SNUG_SHARE_RELAY ?? '').replace(/\/+$/, '');

// Where a share LINK lands: the hosted playground's `/s/<id>#<key>` page (the receiver
// on every platform; the desktop is offered from there, never auto-launched).
export const SHARE_LINK_ORIGIN: string =
  (import.meta.env?.VITE_SNUG_SHARE_LINK_ORIGIN ?? '').replace(/\/+$/, '') || 'https://playground.snugprotocol.org';
export const SHARE_LINK_PATH = '/s';

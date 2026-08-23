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

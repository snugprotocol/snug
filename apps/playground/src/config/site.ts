// The public website, single-homed for the playground/desktop shell.
//
// Dependency direction (ADR-0048): website → playground, never the reverse — the
// website imports our releaseChannel.ts through its `@playground` alias, so this
// constant is playground-OWNED and deliberately not shared back. Any new surface
// linking to the site must import this, not respell the domain.
export const WEBSITE_URL = 'https://snugprotocol.org';

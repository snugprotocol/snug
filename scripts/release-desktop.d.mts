// Type contract for scripts/release-desktop.mjs — consumed by apps/desktop's
// dmgEula.test.ts (one rule, two callers: the release script runs checkEulaText before
// it builds; the desktop suite runs it over the same file). Keep in step with the .mjs.

export const SEMVER: RegExp;
export const STABLE_ASSETS: string[];
export const EULA_MAX_COLUMNS: number;
export const EULA_LINE_BUDGET: number;

export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkEulaText(text: string): Verdict;
export function verifyDmgCarriesEula(xml: string, expectedText: string): Verdict;
export function changelogEntryFor(releasesRaw: string, version: string): { version: string; title?: string; date: string };
export function bumpedJsonConfig(raw: string, version: string): string;
export function bumpedCargoToml(raw: string, version: string): string;
export function buildLatestJson(args: { version: string; pubDate: string; signature: string }): {
  version: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};
export function ghReleaseCommand(version: string): string;
/** TASK-20260904-share-link-ux AC8: the shell's UI build knows the share relay (one constant with deploy-web.mjs). */
export const DESKTOP_PINNED_BUILD_ENV: Readonly<{ VITE_SNUG_SHARE_RELAY: string }>;
export function desktopBuildEnv(env: Record<string, string | undefined>, desktopEnvFiles: string[]): Record<string, string | undefined>;
export function isAppEnvFile(name: string): boolean;
export const SHARE_RELAY_ORIGIN: string;

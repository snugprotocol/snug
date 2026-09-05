#!/usr/bin/env node
// release-desktop.mjs — TASK-20260821-hardening-polish AC11 (ADR-0047 §§6-8).
//
// The desktop release pipeline, run BY THE OWNER on a Mac:
//
//   node scripts/release-desktop.mjs <semver>          # e.g. 0.1.0
//   node scripts/release-desktop.mjs <semver> --dry    # everything except gate+build
//   node scripts/release-desktop.mjs <semver> --publish # ...and create the GitHub Release
//   node scripts/release-desktop.mjs <semver> --no-prompt  # never prompt; env must be complete
//
// Credentials resolve themselves where the machine can answer (updater key path, Apple
// identity + team id from the keychain, Apple ID from git config); the app-specific
// password is PROMPTED, hidden, and never stored.
//
// Steps, in order — each refusal is loud and names its fix:
//   1. refuse unless <semver> has a matching NEWEST entry in
//      apps/playground/src/desktop/desktop-releases.json (release notes are part of a
//      release, not an afterthought — the ADR-0045 doctrine applied to the shell);
//   2. bump the THREE version declarations together (package.json, tauri.conf.json,
//      Cargo.toml — pinned in agreement by versionSync.test.ts);
//   2b. refuse unless src-tauri/EULA.txt passes checkEulaText — the DMG's license
//      screen (ADR-0055 §2, the product's ONE clickwrap) is classic TEXT: ASCII only,
//      short lines, a hard line budget. The desktop suite runs the same function
//      (dmgEula.test.ts imports it), so a wrong file fails twice, in two places;
//   3. run the desktop release gate (gate:release: debug surfaces absent from the
//      release binary) and then `tauri build --target universal-apple-darwin` with
//      updater artifacts; minisign signing rides TAURI_SIGNING_PRIVATE_KEY[_PATH]
//      (custody: ~/.tauri, ADR-0047 §4). Apple signing is ENV-GATED via
//      appleSigningPlan: fully configured signs+notarizes, nothing configured builds
//      unsigned and says so loudly, and HALF-configured is REFUSED (a signed but
//      un-notarized DMG is still Gatekeeper-blocked — TASK-20260824, ADR-0047 §7
//      amendment);
//   3a. prove the artifact is genuinely UNIVERSAL: `lipo -archs` on the Mach-O inside
//      the .app must report BOTH arm64 and x86_64. ADR-0047 §6 points both latest.json
//      platform keys at ONE artifact, so a thin build is silently wrong rather than
//      loudly broken (owner's stated worry, 2026-08-24);
//   3b. NOTARIZE (`notarytool submit --wait`), STAPLE, then verify the staple and ask
//      Gatekeeper itself (`spctl -a -t install`) whether it accepts the result, and
//      accept only source=Notarized Developer ID. Stapling REWRITES the DMG, so this
//      runs before — and the EULA check below runs after — the final bytes exist;
//   3c. prove the built DMG actually CARRIES the EULA: `hdiutil udifderez -xml` dumps
//      the image's resources; verifyDmgCarriesEula decodes the SLA text resource and
//      compares the full text (lessons 2026-08-24: a config is only a contract once
//      the platform's parser accepted it). udifrez/udifderez are deprecated by Apple
//      (still shipped on macOS 26, with a warning) — the refusal names that so the
//      day they vanish the failure is diagnosable, not mysterious;
//   4. stage release-out/ with the STABLE asset names the single-homed URLs expect
//      (Snug.dmg, Snug.app.tar.gz(.sig), latest.json, desktop-releases.json) — both
//      darwin platform keys point at the ONE universal artifact;
//   5. PRINT the `gh release create` command and STOP. Publishing needs an explicit
//      human ask in that session (PROCESS.md release rules; ADR-0047 §13) — this
//      script never talks to GitHub.
//
// The pure parts (validation, bumping, latest.json assembly, the asset plan) are
// exported for scripts/release-desktop.test.mjs, which root `pnpm test` runs via
// `check-release-desktop` (a node:test file with no runner is dead coverage —
// plan-review finding 15).

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pinMatchesManifest, readPin } from './check-helper-pin.mjs';
import { SHARE_RELAY_ORIGIN, isAppEnvFile } from './deploy-web.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const RELEASES_JSON = path.join(ROOT, 'apps', 'playground', 'src', 'desktop', 'desktop-releases.json');
const OUT_DIR = path.join(DESKTOP, 'release-out');
const UNIVERSAL_BUNDLE = path.join(DESKTOP, 'src-tauri', 'target', 'universal-apple-darwin', 'release', 'bundle');
const EULA_PATH = path.join(DESKTOP, 'src-tauri', 'EULA.txt');

export const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * What the shipped shell's UI build must know (TASK-20260904-share-link-ux AC8): the
 * share relay, so the link actions render on the desktop exactly as on the hosted
 * playground. Pinned to deploy-web.mjs's constant so the two builds cannot name two
 * relays.
 */
export const DESKTOP_PINNED_BUILD_ENV = Object.freeze({ VITE_SNUG_SHARE_RELAY: SHARE_RELAY_ORIGIN });
export { isAppEnvFile };

/**
 * The environment `tauri build` runs in. A caller's DIFFERENT relay is refused rather
 * than overridden (a release naming another relay is a different product), and an
 * app-level `.env*` under apps/desktop is refused for the reason deploy-web.mjs refuses
 * it: Vite would fold its VITE_* values into a release no clean-tree check sees.
 */
export function desktopBuildEnv(env, desktopEnvFiles) {
  if (desktopEnvFiles.length) {
    throw new Error(`REFUSED: ${desktopEnvFiles.join(', ')} exists — an app-level .env file can put VITE_* values into the release. Move it aside.`);
  }
  const given = env.VITE_SNUG_SHARE_RELAY;
  if (given !== undefined && given !== DESKTOP_PINNED_BUILD_ENV.VITE_SNUG_SHARE_RELAY) {
    throw new Error(
      `REFUSED: VITE_SNUG_SHARE_RELAY is set to ${JSON.stringify(given)} in the environment; a release pins ${DESKTOP_PINNED_BUILD_ENV.VITE_SNUG_SHARE_RELAY} (ADR-0064). Unset it.`,
    );
  }
  return { ...env, ...DESKTOP_PINNED_BUILD_ENV };
}

/** The stable asset names the playground's single-homed URLs expect (releaseChannel.ts). */
export const STABLE_ASSETS = ['Snug.dmg', 'Snug.app.tar.gz', 'Snug.app.tar.gz.sig', 'latest.json', 'desktop-releases.json'];

/** Refuse a release without a matching NEWEST notes entry. Returns the entry. */
export function changelogEntryFor(releasesRaw, version) {
  let data;
  try {
    data = JSON.parse(releasesRaw);
  } catch (err) {
    throw new Error(`desktop-releases.json is not valid JSON: ${err}`);
  }
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  const newest = releases[0];
  if (newest === undefined) {
    throw new Error('desktop-releases.json has no releases — author the notes entry first');
  }
  if (newest.version !== version) {
    throw new Error(
      `desktop-releases.json's newest entry is v${newest.version}, not v${version} — ` +
        'author this release\'s notes (newest-first) before releasing it',
    );
  }
  return newest;
}

/** package.json / tauri.conf.json: parse, set version, re-serialize (2-space, trailing \n). */
export function bumpedJsonConfig(raw, version) {
  const data = JSON.parse(raw);
  data.version = version;
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Cargo.toml: replace ONLY the [package] version line (the first in the file). */
export function bumpedCargoToml(raw, version) {
  let done = false;
  const out = raw.replace(/^version\s*=\s*"[^"]+"/m, () => {
    done = true;
    return `version = "${version}"`;
  });
  if (!done) throw new Error('Cargo.toml has no version line to bump');
  return out;
}

/**
 * latest.json for the Tauri updater. BOTH darwin keys point at the ONE universal
 * artifact (ADR-0047 §6); the url is the VERSIONED asset path, so a cached manifest
 * can never pair one release's signature with another's bytes.
 */
export function buildLatestJson({ version, pubDate, signature }) {
  if (!SEMVER.test(version)) throw new Error(`not a semver version: ${version}`);
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new Error('missing updater signature (.sig contents)');
  }
  const url = `https://github.com/snugprotocol/snug/releases/download/v${version}/Snug.app.tar.gz`;
  const platform = { signature, url };
  return {
    version,
    pub_date: pubDate,
    platforms: { 'darwin-aarch64': platform, 'darwin-x86_64': platform },
  };
}

// ---------------------------------------------------------------- the DMG EULA (ADR-0055 §2)

/**
 * The SLA window is small and the resource is classic TEXT (Mac Roman): a curly quote
 * or an em dash renders as garbage, a long line wraps badly, and a long text is a
 * clickwrap nobody reads. The line budget is derived from the accepted draft plus
 * headroom (plan-review finding 15), not a hope about a future one.
 */
export const EULA_MAX_COLUMNS = 74;
export const EULA_LINE_BUDGET = 60;

/** Shape check over the EULA text. `{ ok: true }` or `{ ok: false, reason }` — never throws. */
export function checkEulaText(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'EULA text is empty' };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bad = /[^\x09\x0a\x0d\x20-\x7e]/.exec(line);
    if (bad !== null) {
      return {
        ok: false,
        reason: `non-ASCII character ${JSON.stringify(bad[0])} at line ${i + 1} — the SLA resource is classic TEXT; use straight quotes and hyphens`,
      };
    }
    if (line.length > EULA_MAX_COLUMNS) {
      return { ok: false, reason: `line ${i + 1} is ${line.length} columns; the SLA window wraps past ${EULA_MAX_COLUMNS}` };
    }
  }
  if (lines.length > EULA_LINE_BUDGET) {
    return { ok: false, reason: `${lines.length} lines; the EULA budget is ${EULA_LINE_BUDGET} lines (a screen someone reads standing up)` };
  }
  return { ok: true };
}

const UDIFDEREZ_NOTE =
  'Apple deprecated `hdiutil udifrez/udifderez` in macOS 12 (still shipped, with a warning); ' +
  'if this check stops finding resources on a newer macOS, that deprecation is the first suspect.';

/**
 * Given `hdiutil udifderez -xml <dmg>` output, confirm the image carries an SLA whose
 * DECODED text is exactly `expectedText` (a full-text compare is free once the resource
 * is decoded — first-line-only would wave through a stale EULA with the same title;
 * Gate-5 review F6). The body is base64 inside <data> (the bundler's
 * eula-resources-template.xml), so a raw substring check on the dump either always fails
 * against a real fixture or always passes against a hand-typed one — decode first.
 * Line endings are normalised before comparing. Never throws: garbage in → a named
 * refusal.
 */
export function verifyDmgCarriesEula(xml, expectedText) {
  if (typeof xml !== 'string' || !xml.includes('<key>LPic</key>')) {
    return { ok: false, reason: `no SLA resource in the udifderez dump (no LPic key) — the DMG has no license screen. ${UDIFDEREZ_NOTE}` };
  }
  const m = /<key>(TEXT|RTF )<\/key>\s*<array>[\s\S]*?<data>([\s\S]*?)<\/data>/.exec(xml);
  if (m === null) {
    return { ok: false, reason: `LPic present but no TEXT/RTF resource with a <data> body in the udifderez dump. ${UDIFDEREZ_NOTE}` };
  }
  let decoded;
  try {
    decoded = Buffer.from(m[2].replace(/\s+/g, ''), 'base64').toString('latin1');
  } catch (err) {
    return { ok: false, reason: `could not base64-decode the SLA ${m[1].trim()} resource: ${err}` };
  }
  const normalise = (s) => s.replace(/\r\n?/g, '\n');
  if (normalise(decoded) !== normalise(String(expectedText ?? ''))) {
    const got = normalise(decoded).split('\n')[0] ?? '';
    const exp = normalise(String(expectedText ?? '')).split('\n')[0] ?? '';
    return {
      ok: false,
      reason: `SLA text mismatch — the DMG carries a different EULA (its first line: ${JSON.stringify(got)}; expected first line: ${JSON.stringify(exp)})`,
    };
  }
  return { ok: true };
}


// ---------------------------------------------------------------- the universal binary (ADR-0047 §6)

/** The two architectures a shipped Snug binary must contain. `arm64e` is NOT `arm64`. */
export const REQUIRED_ARCHS = ['arm64', 'x86_64'];

/**
 * Parse `lipo -archs <binary>` and insist on a genuinely fat arm64+x86_64 image.
 *
 * ADR-0047 §6 chose one universal artifact served to BOTH `latest.json` platform keys.
 * That makes a thin build silently wrong rather than loudly broken: `darwin-aarch64`
 * would hand Apple Silicon users an Intel-only binary (Rosetta at best), and nothing
 * downstream — not the gate, not the EULA check, not the updater — would notice.
 *
 * Exact-token matching matters. `/bin/ls` reports `x86_64 arm64e`; a substring test for
 * 'arm64' passes on `arm64e`, which is the pointer-authentication ABI, not a
 * distribution architecture. Never throws: unparseable output is a refusal, because a
 * check that cannot fail proves nothing (run-release-gate.mjs's positive-control doctrine).
 */
export function checkUniversalArchs(lipoOutput) {
  if (typeof lipoOutput !== 'string' || lipoOutput.trim() === '') {
    return { ok: false, reason: 'no `lipo -archs` output to check — the architecture scan did not run' };
  }
  const archs = lipoOutput.trim().split(/\s+/);
  const missing = REQUIRED_ARCHS.filter((a) => !archs.includes(a));
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `the built binary is not universal: missing ${missing.join(' + ')} (lipo reports: ${archs.join(' ')}) — ` +
        'ADR-0047 §6 ships ONE artifact for both darwin platform keys, so a thin build hands the ' +
        'other architecture a binary it cannot run natively. Check `rustup target list --installed` ' +
        'and that the build used --target universal-apple-darwin.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- Apple signing + notarization (ADR-0047 §7)

/**
 * Decide the signing mode from the environment — `signed`, `unsigned`, or `refused`.
 *
 * The middle state is the point. Before this, `APPLE_SIGNING_IDENTITY` was read as a
 * bare boolean, so an identity set WITHOUT notary credentials produced a signed but
 * un-notarized DMG — which Gatekeeper still blocks, after a long build, in a way that
 * looks like success in the logs. Half-configured is refused, never downgraded.
 *
 * The identity kind is checked too: `Apple Development` certs sign happily and then fail
 * notarization at the far end of the slowest step in the pipeline. Only a
 * `Developer ID Application` cert can notarize for outside-the-store distribution.
 */
export function appleSigningPlan(env = {}) {
  const identity = String(env.APPLE_SIGNING_IDENTITY ?? '').trim();
  // Tauri's OWN bundler performs notarization mid-build, and it reads only these
  // trios — never a keychain profile (verified against tauri-cli 2.x, which warns
  // "skipping app notarization, no APPLE_ID & APPLE_PASSWORD & APPLE_TEAM_ID or
  // APPLE_API_KEY & APPLE_API_ISSUER & APPLE_API_KEY_PATH"). This MUST be the
  // mechanism: the bundler notarizes the .app BEFORE wrapping it in the DMG, and
  // notarizing only the DMG afterwards leaves the app the user actually runs
  // un-notarized once it is copied to /Applications (TASK-20260824 build 1).
  const appleId = String(env.APPLE_ID ?? '').trim();
  const applePassword = String(env.APPLE_PASSWORD ?? '').trim();
  const appleTeamId = String(env.APPLE_TEAM_ID ?? '').trim();
  const apiKey = String(env.APPLE_API_KEY ?? '').trim();
  const apiIssuer = String(env.APPLE_API_ISSUER ?? '').trim();
  const apiKeyPath = String(env.APPLE_API_KEY_PATH ?? '').trim();
  const hasAppleIdTrio = appleId !== '' && applePassword !== '' && appleTeamId !== '';
  const hasApiTrio = apiKey !== '' && apiIssuer !== '' && apiKeyPath !== '';
  const profile = hasAppleIdTrio || hasApiTrio ? 'tauri' : '';
  if (identity === '' && profile === '') {
    return {
      mode: 'unsigned',
      reason:
        'APPLE_SIGNING_IDENTITY absent — building UNSIGNED (Gatekeeper right-click-open; the ' +
        '/download page must keep its disclosure).',
    };
  }
  if (identity === '') {
    return {
      mode: 'refused',
      reason: 'notarization credentials are set but APPLE_SIGNING_IDENTITY is not — half-configured signing.',
    };
  }
  if (!identity.startsWith('Developer ID Application:')) {
    return {
      mode: 'refused',
      reason:
        `APPLE_SIGNING_IDENTITY is ${JSON.stringify(identity)}, which is not a "Developer ID Application:" ` +
        'certificate. Only that kind notarizes for distribution outside the Mac App Store; a Development ' +
        'cert signs fine and then fails notarization at the end of the build.',
    };
  }
  if (profile === '') {
    return {
      mode: 'refused',
      reason:
        'APPLE_SIGNING_IDENTITY is set but no notarization credentials are — the build would produce a ' +
        'signed-but-UN-NOTARIZED artifact, which Gatekeeper still blocks. Tauri\'s bundler needs either ' +
        'APPLE_ID + APPLE_PASSWORD (app-specific) + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER + ' +
        'APPLE_API_KEY_PATH. A notarytool keychain profile does NOT work here — the bundler never reads it ' +
        '(ADR-0047 §7 amendment).',
    };
  }
  return { mode: 'signed', identity, notarization: hasApiTrio ? 'api-key' : 'apple-id' };
}

/**
 * `xcrun stapler validate` — the ticket must be attached to the artifact itself.
 *
 * Notarizing without stapling is the classic silent failure: Gatekeeper falls back to
 * an online check, so it works on the developer's machine and fails for a user who is
 * offline or whom Apple's CDN cannot answer for at first launch.
 */
export function checkStapleOutput(output) {
  if (typeof output !== 'string' || output.trim() === '') {
    return { ok: false, reason: 'no `stapler validate` output — the staple check did not run' };
  }
  // BOTH of Apple's success wordings, learned from a real run (2026-08-26):
  //   `stapler staple <path>`   → "The staple and validate action worked!"
  //   `stapler validate <path>` → "The validate action worked!"
  // This function is called on the output of `validate`, so the second is the one that
  // normally appears; the first was the only accepted spelling until a release refused on
  // "The validate action worked!" — a correctly stapled artifact rejected by its own check.
  // Matching the shared suffix accepts both and still refuses every failure wording below.
  if (/\bvalidate action worked!/i.test(output)) return { ok: true };
  if (/does not have a ticket stapled/i.test(output)) {
    return { ok: false, reason: 'the artifact has NO notarization ticket stapled to it — first launch will fail offline' };
  }
  return { ok: false, reason: `stapler validate did not report success: ${output.trim().split('\n').slice(-1)[0]}` };
}

/**
 * `spctl -a -vvv -t install` — Gatekeeper's own verdict, the closest thing to the user's
 * first double-click that a script can obtain.
 *
 * Both halves are load-bearing: `accepted` AND a `source=` naming notarization. An
 * artifact can be accepted for unrelated reasons (store signing, an ad-hoc exception),
 * and matching on "accepted" alone would wave those through as if notarization worked.
 */
export function checkSpctlOutput(output) {
  if (typeof output !== 'string' || output.trim() === '') {
    return { ok: false, reason: 'no `spctl` output — the Gatekeeper check did not run' };
  }
  if (/:\s*rejected/i.test(output)) {
    const source = /source=(.*)/i.exec(output)?.[1]?.trim() ?? 'unknown';
    return {
      ok: false,
      reason: `Gatekeeper REJECTED the artifact (source=${source}) — signed but not notarized, or the notarization did not attach`,
    };
  }
  if (!/:\s*accepted/i.test(output)) {
    return { ok: false, reason: `spctl returned neither accepted nor rejected: ${output.trim().split('\n')[0]}` };
  }
  if (!/source=Notarized Developer ID/i.test(output)) {
    const source = /source=(.*)/i.exec(output)?.[1]?.trim() ?? 'absent';
    return {
      ok: false,
      reason: `Gatekeeper accepted the artifact but source=${source}, not "Notarized Developer ID" — accepted for some other reason`,
    };
  }
  return { ok: true };
}

/**
 * ADR-0060 §10 / plan-review finding 6: a shell that pins a helper tag nobody published
 * sends every Telepath user to a 404. Parse the pin out of helper_install.rs (never restate
 * it) and require `gh release view <tag>` to succeed before anything is staged.
 */
export function pinnedHelperTags(pinnedHelpers) {
  return pinnedHelpers.map((h) => h.tag);
}

/**
 * `ghView(tag)` → the PUBLISHED helper.json (parsed) or undefined. Existence alone is not
 * enough (review: cross-file 1): the published sums must equal the pin, or every user's
 * download verifies the signature and then refuses on the content pin.
 */
export function pinnedHelperIsPublished(pinnedHelpers, ghView) {
  for (const h of pinnedHelpers) {
    const manifest = ghView(h.tag);
    if (manifest === undefined) return { ok: false, reason: `pinned helper release ${h.tag} is not published — run scripts/release-helper.mjs and create it first (ADR-0060 §10)` };
    const problems = pinMatchesManifest(h, manifest);
    if (problems.length > 0) return { ok: false, reason: `published ${h.tag} does not match the shell's pin: ${problems.join('; ')}` };
  }
  return { ok: true };
}

/**
 * REFUSE to rebuild over an existing SIGNED build when this run has no Apple credentials.
 *
 * Learned the hard way 2026-08-26: a signed+notarized v0.1.2 DMG was already on disk when the
 * script was re-run (to finish the staging step) WITHOUT the credential trio in the
 * environment. `tauri build` rebuilt from source, `appleSigned` was false, and the notarized
 * artifact was replaced by an adhoc one — ~9 minutes of build and an Apple round trip
 * destroyed by a command whose stated purpose was "stage what is already built". The build is
 * reproducible, so nothing was unrecoverable; it is refused anyway, because a destructive
 * rebuild is never what the caller meant.
 *
 * `spctlOutput` is the *existing* artifact's verdict (undefined when there is no artifact).
 */
export function refuseUnsignedRebuildOverSignedBuild({ appleSigned, existingDmg, spctlOutput }) {
  if (appleSigned || existingDmg === undefined) return { ok: true };
  if (spctlOutput !== undefined && /source=Notarized Developer ID/.test(spctlOutput)) {
    return {
      ok: false,
      reason:
        `${existingDmg} is already SIGNED and NOTARIZED, and this run has no Apple credentials — ` +
        'rebuilding would replace it with an unsigned artifact. Export the credential trio ' +
        '(APPLE_SIGNING_IDENTITY + APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID) and re-run, or ' +
        'delete the bundle directory first if an unsigned build is genuinely what you want.',
    };
  }
  return { ok: true };
}

/**
 * The signing identity this machine actually holds, from the keychain.
 *
 * `security find-identity` output looks like:
 *   1) E9B4…BB2 "Developer ID Application: Jitendra Maker (2KC5X47563)"
 * Returns `{ identity, teamId }` — the team id is the parenthesised suffix, which is
 * exactly what APPLE_TEAM_ID wants, so neither has to be typed or remembered.
 */
export function parseSigningIdentity(securityOutput) {
  const lines = String(securityOutput ?? '')
    .split('\n')
    .map((l) => l.match(/"(Developer ID Application: [^"]+)"/))
    .filter(Boolean)
    .map((m) => m[1]);
  if (lines.length === 0) return { ok: false, reason: 'no "Developer ID Application" identity in the keychain' };
  if (lines.length > 1) {
    return { ok: false, reason: `the keychain holds ${lines.length} Developer ID identities; set APPLE_SIGNING_IDENTITY explicitly: ${lines.join(' | ')}` };
  }
  const identity = lines[0];
  const teamId = (identity.match(/\(([A-Z0-9]{10})\)\s*$/) ?? [])[1];
  return teamId === undefined ? { ok: false, reason: `could not read a team id out of ${JSON.stringify(identity)}` } : { ok: true, identity, teamId };
}

/** Read a secret from the TTY without echoing it, and without it reaching argv or history. */
async function promptSecret(question) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const onData = (char) => {
      // Re-render the prompt with no echo while the user types.
      if (['\n', '\r', '\u0004'].includes(String(char))) return;
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/**
 * Fill the release environment in place: the updater key path (custody is fixed by
 * ADR-0047 §4), the Apple identity + team id from the keychain, the Apple ID from git
 * config or the environment, and the app-specific password by PROMPT.
 *
 * Nothing is written to disk and nothing reaches argv — the password is read from the TTY
 * and stays in this process's environment for the child builds.
 */
export async function resolveSigningCredentials(env, { interactive, exec = execSync, prompt = promptSecret } = {}) {
  const notes = [];
  const DEFAULT_KEY = path.join(process.env.HOME ?? '~', '.tauri', 'snug-updater.key');
  if (!env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH && existsSync(DEFAULT_KEY)) {
    env.TAURI_SIGNING_PRIVATE_KEY_PATH = DEFAULT_KEY;
    notes.push(`· updater key ← ${DEFAULT_KEY} (ADR-0047 §4 custody)`);
  }
  if (!env.APPLE_SIGNING_IDENTITY || !env.APPLE_TEAM_ID) {
    let found;
    try {
      found = parseSigningIdentity(exec('security find-identity -v -p codesigning', { encoding: 'utf8' }));
    } catch (err) {
      found = { ok: false, reason: `could not read the keychain: ${err}` };
    }
    if (found.ok) {
      if (!env.APPLE_SIGNING_IDENTITY) {
        env.APPLE_SIGNING_IDENTITY = found.identity;
        notes.push(`· APPLE_SIGNING_IDENTITY ← keychain (${found.identity})`);
      }
      if (!env.APPLE_TEAM_ID) {
        env.APPLE_TEAM_ID = found.teamId;
        notes.push(`· APPLE_TEAM_ID ← ${found.teamId} (from the identity)`);
      }
    } else {
      notes.push(`· ${found.reason}`);
    }
  }
  if (!env.APPLE_ID) {
    try {
      const email = exec('git config --get user.email', { encoding: 'utf8' }).trim();
      if (email !== '') {
        env.APPLE_ID = email;
        notes.push(`· APPLE_ID ← git config user.email (${email})`);
      }
    } catch {
      /* no git identity; the refusal below names it */
    }
  }
  if (!env.APPLE_PASSWORD && env.APPLE_SIGNING_IDENTITY && interactive) {
    // The ONE secret a machine cannot derive. Prompted, never echoed, never stored.
    env.APPLE_PASSWORD = await prompt(`app-specific password for ${env.APPLE_ID ?? 'your Apple ID'} (from 1Password; input hidden): `);
    notes.push('· APPLE_PASSWORD ← prompt (not stored)');
  }
  for (const note of notes) console.log(note);
  return env;
}

/** The gh command PRINTED for the owner — never executed here (PROCESS.md release rules). */
export function ghReleaseCommand(version) {
  const files = STABLE_ASSETS.map((name) => `release-out/${name}`).join(' ');
  return (
    `gh release create v${version} --repo snugprotocol/snug ` +
    `--title "Snug desktop v${version}" --notes "See desktop-releases.json / the in-app release notes." ` +
    files
  );
}

function findOne(dir, suffix) {
  const hits = readdirSync(dir).filter((f) => f.endsWith(suffix));
  if (hits.length !== 1) throw new Error(`expected exactly one *${suffix} in ${dir}, found ${hits.length}`);
  return path.join(dir, hits[0]);
}

async function main() {
  const [version, ...flags] = process.argv.slice(2);
  const dry = flags.includes('--dry');
  if (!version || !SEMVER.test(version)) {
    console.error('usage: node scripts/release-desktop.mjs <major.minor.patch> [--dry]');
    process.exit(2);
  }

  const entry = changelogEntryFor(readFileSync(RELEASES_JSON, 'utf8'), version);
  console.log(`✔ release notes present: v${entry.version} — ${entry.title ?? '(untitled)'} (${entry.date})`);

  const eulaText = existsSync(EULA_PATH) ? readFileSync(EULA_PATH, 'utf8') : '';
  const eulaShape = checkEulaText(eulaText);
  if (!eulaShape.ok) {
    console.error(`REFUSED: src-tauri/EULA.txt — ${eulaShape.reason} (ADR-0055 §2; edit legal/eula.ts and copy it over).`);
    process.exit(2);
  }
  console.log('✔ EULA.txt passes the SLA shape check');

  const helperCheck = pinnedHelperIsPublished(readPin(), (tag) => {
    try {
      const raw = execSync(`curl -fsSL https://github.com/snugprotocol/snug/releases/download/${tag}/helper.json`, { stdio: 'pipe' }).toString();
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  });
  if (!helperCheck.ok) {
    console.error(`REFUSED: ${helperCheck.reason}`);
    process.exit(2);
  }
  console.log('✔ every pinned helper release is published');

  const pkgPath = path.join(DESKTOP, 'package.json');
  const confPath = path.join(DESKTOP, 'src-tauri', 'tauri.conf.json');
  const cargoPath = path.join(DESKTOP, 'src-tauri', 'Cargo.toml');
  writeFileSync(pkgPath, bumpedJsonConfig(readFileSync(pkgPath, 'utf8'), version));
  writeFileSync(confPath, bumpedJsonConfig(readFileSync(confPath, 'utf8'), version));
  writeFileSync(cargoPath, bumpedCargoToml(readFileSync(cargoPath, 'utf8'), version));
  console.log(`✔ version ${version} written to package.json, tauri.conf.json, Cargo.toml`);

  // Fill in what the machine can answer for, and PROMPT for the one secret that lives in
  // a vault. Before this the caller had to export five variables by hand, and every
  // mistake surfaced only after the slowest step (2026-08-26: a wrong flag combination
  // after a full notarization round trip). `--no-prompt` keeps the old fully-explicit
  // behaviour for a non-interactive caller.
  if (!flags.includes('--no-prompt')) {
    await resolveSigningCredentials(process.env, { interactive: process.stdin.isTTY === true });
  }

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    console.error(
      'REFUSED: no TAURI_SIGNING_PRIVATE_KEY[_PATH] in the environment — updater artifacts ' +
        'must be minisign-signed (ADR-0047 §4; key custody ~/.tauri/snug-updater.key).',
    );
    process.exit(2);
  }
  // `tauri build` reads the key CONTENTS from TAURI_SIGNING_PRIVATE_KEY and never the
  // _PATH form — it fails with "A public key has been found, but no private key" deep
  // in the bundler, long after this guard passed (2026-08-26). `tauri signer sign`
  // below is the opposite: it takes a file via -f. Accept either input and satisfy
  // both consumers by materialising the contents here.
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
    if (!existsSync(keyPath)) {
      console.error(`REFUSED: TAURI_SIGNING_PRIVATE_KEY_PATH points at ${keyPath}, which does not exist.`);
      process.exit(2);
    }
    process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8').trim();
    console.log('· TAURI_SIGNING_PRIVATE_KEY absent → read from TAURI_SIGNING_PRIVATE_KEY_PATH (tauri build needs the contents)');
  }
  // An UNSET password is not an empty one: tauri prompts for it, and a build with no
  // TTY dies with "incorrect updater private key password: Device not configured
  // (os error 6)" — AFTER the notarization round-trip, which is the slowest and only
  // irreversible-in-cost step. Twice on 2026-08-24/25. Default it explicitly so the
  // key's actual state (no passphrase) is what the signer is told.
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
    console.log('· TAURI_SIGNING_PRIVATE_KEY_PASSWORD unset → defaulted to empty (the key has no passphrase)');
  }
  const signing = appleSigningPlan(process.env);
  if (signing.mode === 'refused') {
    console.error(`REFUSED: ${signing.reason}`);
    process.exit(2);
  }
  const appleSigned = signing.mode === 'signed';
  if (appleSigned) {
    console.log(`✔ Apple signing: ${signing.identity} (notary profile "${signing.keychainProfile}")`);
  } else {
    console.warn(`⚠ ${signing.reason}`);
  }

  if (dry) {
    console.log('--dry: skipping gate:release, build, and staging.');
    console.log(`next (needs an explicit ask): ${ghReleaseCommand(version)}`);
    return;
  }

  console.log('running the desktop release gate…');
  execSync('pnpm --filter desktop gate:release', { cwd: ROOT, stdio: 'inherit' });
  console.log('building (universal-apple-darwin, updater artifacts)…');
  // Guard against the destructive rebuild described on refuseUnsignedRebuildOverSignedBuild.
  {
    let existingDmg;
    try {
      existingDmg = findOne(path.join(UNIVERSAL_BUNDLE, 'dmg'), '.dmg');
    } catch {
      existingDmg = undefined;
    }
    let spctlOutput;
    if (existingDmg !== undefined) {
      try {
        spctlOutput = execSync(`spctl -a -t open --context context:primary-signature -vv "${existingDmg}" 2>&1`, { encoding: 'utf8' });
      } catch (err) {
        spctlOutput = String(err.stdout ?? '');
      }
    }
    const verdict = refuseUnsignedRebuildOverSignedBuild({ appleSigned, existingDmg, spctlOutput });
    if (!verdict.ok) {
      console.error(`REFUSED: ${verdict.reason}`);
      process.exit(2);
    }
  }

  let buildEnv;
  try {
    const desktopEnvFiles = readdirSync(path.join(ROOT, 'apps/desktop'))
      .filter(isAppEnvFile)
      .map((f) => `apps/desktop/${f}`);
    buildEnv = desktopBuildEnv(process.env, desktopEnvFiles);
  } catch (err) {
    console.error(String(err.message));
    process.exit(2);
  }
  console.log(`· VITE_SNUG_SHARE_RELAY=${buildEnv.VITE_SNUG_SHARE_RELAY} (pinned — the shell's share links)`);
  execSync('pnpm --filter desktop exec tauri build --target universal-apple-darwin', {
    cwd: ROOT,
    stdio: 'inherit',
    env: buildEnv,
  });

  const dmg = findOne(path.join(UNIVERSAL_BUNDLE, 'dmg'), '.dmg');
  const appBundle = findOne(path.join(UNIVERSAL_BUNDLE, 'macos'), '.app');

  // 3a — ADR-0047 §6: the ONE artifact both platform keys point at must actually be fat.
  // Checked on the Mach-O inside the .app, not the DMG (a disk image has no architecture).
  //
  // The executable name comes from Info.plist, NOT from the bundle name: the bundle is
  // `Snug.app` but the binary inside is `snug-desktop` (Cargo's package name), and
  // hardcoding either spelling breaks the moment productName and the crate name differ
  // — as they already do here.
  const execName = execSync(
    `/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "${path.join(appBundle, 'Contents', 'Info.plist')}"`,
    { encoding: 'utf8' },
  ).trim();
  const mainBinary = path.join(appBundle, 'Contents', 'MacOS', execName);
  if (!existsSync(mainBinary)) {
    console.error(`REFUSED: Info.plist names CFBundleExecutable=${execName}, but ${mainBinary} does not exist.`);
    process.exit(2);
  }
  let archOut;
  try {
    archOut = execSync(`lipo -archs "${mainBinary}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    console.error(`REFUSED: could not read the built binary's architectures (lipo failed on ${mainBinary}): ${err}`);
    process.exit(2);
  }
  const universal = checkUniversalArchs(archOut);
  if (!universal.ok) {
    console.error(`REFUSED: ${universal.reason}`);
    process.exit(2);
  }
  console.log(`✔ universal binary: ${archOut.trim()}`);

  // 3b — NOTARIZE, then STAPLE, then verify. Order matters twice over: stapling
  // REWRITES the DMG, so both the Gatekeeper check and the EULA check below must run
  // against the final bytes, not the pre-staple ones (review F9 named this interaction
  // as unverified; it is verified here).
  if (appleSigned) {
    // Tauri's bundler submitted the **.app** to Apple during `tauri build` (as
    // Snug.zip — that is why the APPLE_ID/API-key trio is mandatory above). It does
    // NOT submit the DMG, and a notarization ticket is keyed to the HASH OF ONE FILE:
    // stapling the DMG against the app's ticket fails with "Record not found /
    // CloudKit query ... failed" (observed 2026-08-25). The DMG is a separate
    // artifact and needs its own submission. Both matter: the DMG is what a human
    // downloads, the .app is what survives the drag to /Applications.
    console.log('submitting the DMG to Apple for its own notarization (minutes, not seconds)…');
    const notaryAuth =
      signing.notarization === 'api-key'
        ? `--key "${process.env.APPLE_API_KEY_PATH}" --key-id "${process.env.APPLE_API_KEY}" --issuer "${process.env.APPLE_API_ISSUER}"`
        : `--apple-id "${process.env.APPLE_ID}" --password "${process.env.APPLE_PASSWORD}" --team-id "${process.env.APPLE_TEAM_ID}"`;
    execSync(`xcrun notarytool submit "${dmg}" ${notaryAuth} --wait`, { stdio: 'inherit' });
    console.log('stapling the notarization ticket to the DMG…');
    execSync(`xcrun stapler staple "${dmg}"`, { stdio: 'inherit' });

    const stapleOut = execSync(`xcrun stapler validate "${dmg}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const stapled = checkStapleOutput(stapleOut);
    if (!stapled.ok) {
      console.error(`REFUSED: ${stapled.reason}`);
      process.exit(2);
    }
    console.log('✔ notarization ticket stapled to the DMG');

    // …and to the .app itself. The DMG is a delivery wrapper the user discards; the
    // bundle they drag to /Applications is what Gatekeeper judges at every launch.
    // Stapling one does not staple the other.
    execSync(`xcrun stapler staple "${appBundle}"`, { stdio: 'inherit' });
    const appStaple = checkStapleOutput(
      execSync(`xcrun stapler validate "${appBundle}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }),
    );
    if (!appStaple.ok) {
      console.error(`REFUSED: the .app bundle — ${appStaple.reason}`);
      process.exit(2);
    }
    console.log('✔ notarization ticket stapled to Snug.app');

    // spctl EXITS NON-ZERO on rejection, so the throw is the rejection path — capture
    // stdout+stderr either way and let checkSpctlOutput name the verdict.
    let spctlOut;
    try {
      spctlOut = execSync(`spctl -a -vvv -t install "${dmg}" 2>&1`, { encoding: 'utf8', shell: '/bin/sh' });
    } catch (err) {
      spctlOut = String(err?.stdout ?? '') + String(err?.stderr ?? '');
    }
    const gate = checkSpctlOutput(spctlOut);
    if (!gate.ok) {
      console.error(`REFUSED: ${gate.reason}\n${spctlOut.trim()}`);
      process.exit(2);
    }
    console.log('✔ Gatekeeper accepts the stapled DMG (source=Notarized Developer ID)');

    // REBUILD the updater tarball from the STAPLED app. `tauri build` created
    // Snug.app.tar.gz from the .app as it stood BEFORE stapling, so shipping that
    // file would hand every auto-updating client an un-stapled bundle — the exact
    // offline-first-launch failure the staple exists to prevent, delivered by the
    // update path instead of the download path.
    const staleTar = path.join(UNIVERSAL_BUNDLE, 'macos', 'Snug.app.tar.gz');
    console.log('rebuilding the updater tarball from the stapled .app…');
    execSync(`rm -f "${staleTar}" "${staleTar}.sig"`, { stdio: 'inherit' });
    execSync(`tar -czf "${staleTar}" -C "${path.dirname(appBundle)}" "${path.basename(appBundle)}"`, {
      stdio: 'inherit',
    });
    // Re-sign it with the updater key: the .sig tauri produced belonged to the old bytes.
    // KEY BY ENV, EXACTLY ONE SPELLING. `tauri signer sign` maps `-k` to
    // TAURI_SIGNING_PRIVATE_KEY and `-f` to TAURI_SIGNING_PRIVATE_KEY_PATH (`--help`), and
    // refuses the pair however it arrives — as flags OR as two env vars. This script
    // materialises the CONTENTS form above because `tauri build` reads only that one, so
    // the PATH form must be dropped for this child. Twice on 2026-08-26: first as a `-f`
    // flag beside the env contents, then as both env vars at once.
    const signerEnv = { ...process.env };
    delete signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH;
    execSync(`pnpm --filter desktop exec tauri signer sign "${staleTar}"`, {
      env: signerEnv,
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log('✔ updater tarball rebuilt from the stapled app and re-signed');
  }

  // 3c — the platform's own parser vouches for the clickwrap. AFTER stapling (above).
  let dump;
  try {
    dump = execSync(`hdiutil udifderez -xml "${dmg}"`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    // The verb itself failing is the deprecation's expected failure mode (review F5) —
    // name it here, where the stack trace alone would say nothing useful.
    console.error(`REFUSED: hdiutil udifderez failed on the built DMG: ${err}. ${UDIFDEREZ_NOTE}`);
    process.exit(2);
  }
  const carries = verifyDmgCarriesEula(dump, eulaText);
  if (!carries.ok) {
    console.error(`REFUSED: the built DMG does not carry the EULA — ${carries.reason}`);
    process.exit(2);
  }
  console.log('✔ the DMG carries the EULA (SLA resource verified via hdiutil udifderez)');
  const tarGz = findOne(path.join(UNIVERSAL_BUNDLE, 'macos'), '.app.tar.gz');
  const sig = `${tarGz}.sig`;
  if (!existsSync(sig)) throw new Error(`missing updater signature beside the artifact: ${sig}`);

  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(dmg, path.join(OUT_DIR, 'Snug.dmg'));
  copyFileSync(tarGz, path.join(OUT_DIR, 'Snug.app.tar.gz'));
  copyFileSync(sig, path.join(OUT_DIR, 'Snug.app.tar.gz.sig'));
  copyFileSync(RELEASES_JSON, path.join(OUT_DIR, 'desktop-releases.json'));
  const latest = buildLatestJson({
    version,
    pubDate: new Date().toISOString(),
    signature: readFileSync(sig, 'utf8'),
  });
  writeFileSync(path.join(OUT_DIR, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`✔ staged ${OUT_DIR} (${STABLE_ASSETS.join(', ')})${appleSigned ? '' : ' — UNSIGNED build'}`);

  if (!appleSigned) {
    console.log('\nUNSIGNED build — not publishable. Nothing was released.');
    return;
  }

  // PUBLISH is opt-in and explicit (PROCESS.md release rules: a GitHub Release needs an
  // explicit human ask in the session). `--publish` IS that ask, given on the command
  // line by the person running it; without the flag the command is printed, as before.
  if (flags.includes('--publish')) {
    console.log(`\npublishing v${version}…`);
    execSync(ghReleaseCommand(version), { cwd: DESKTOP, stdio: 'inherit' });
    console.log(`✔ released v${version} — record it in the task journal (PROCESS.md release rules).`);
    return;
  }

  console.log('\nStaged but NOT published. To publish (an explicit ask), re-run with --publish, or:');
  console.log(`  cd apps/desktop && ${ghReleaseCommand(version)}`);
  console.log('…and record the publish in the task journal (PROCESS.md release rules).');
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(String(err?.stack ?? err));
    process.exit(1);
  });
}

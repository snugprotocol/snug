// availability.test.ts — TASK-20261003 R3 (ADR-0072 §4): the ONE derivation behind every
// surface that offers an app. S1 (needs, offers, the verdict and its copy — pure), the matrix
// over the twelve shipped starters × every host, the web shell's REAL platform object through
// `offersOf`, and S4's source lint (no capability decision reads the platform's `kind`).
//
// WHY A MATRIX OVER THE REAL MANIFESTS. The gate this replaces was a `desktopOnly` flag in a
// UI table: one reason string for three starters, true for one of them, and wrong under the
// local runner (where a Node process, not a browser page, carries the request — so Trade
// Copilot works there and was locked). A table written by hand in a test would restate the
// same guess; reading `examples/*/connection.json` through the real `StarterSource` means a
// manifest edit, a registry `browserCallable` edit or a thirteenth starter each move a row
// HERE, by name.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionRequirement } from '@snugprotocol/protocol';

import {
  CONNECTIONS_UNAVAILABLE,
  HOST_OFFERS,
  RUNS_IN_LABEL,
  availabilityOf,
  needsOfConnections,
  needsOfRequirement,
  offersOf,
  signedIn,
  type AppNeed,
  type HostOffers,
  type RunsIn,
} from '../platform/availability.js';
import type { SnugPlatform } from '../platform/platform.js';
import { STARTER_PREFIX } from '../starter/starterApps.js';
import { starterDeclarationForStarterId } from '../starter/starterDeclaration.js';
import { starterSource } from '../starter/starterSource.js';

const NOTHING: HostOffers = { network: false, 'native-fetch': false, oauth: false, lan: false, helper: false };

/** The hosts, as LITERAL offers — never read back from the module under test. */
const HOSTS = {
  web: { network: true, 'native-fetch': false, oauth: true, lan: false, helper: false },
  desktop: { network: true, 'native-fetch': true, oauth: true, lan: true, helper: true },
  artifact: NOTHING,
  file: NOTHING,
  runner: { network: true, 'native-fetch': true, oauth: true, lan: false, helper: false },
  'runner, oauthRedirect:false': { network: true, 'native-fetch': true, oauth: false, lan: false, helper: false },
} as const satisfies Record<string, HostOffers>;

type HostName = keyof typeof HOSTS;

/** What each starter needs — the twelve folders, each named, so a thirteenth fails the count below. */
const NEEDS: Record<string, readonly AppNeed[]> = {
  'adventure-quest': [],
  chess: [],
  'flying-pig': [],
  'quiz-me': [],
  github: ['network'],
  gmail: ['network', 'oauth'],
  hue: ['lan'],
  ledger: ['network'],
  spotify: ['network', 'oauth'],
  'trade-copilot': ['network', 'native-fetch'],
  weather: ['network'],
  whatsapp: ['helper'],
};

/** Per host: the starters it CANNOT run, each with its blockers in the order a tile reads them. */
const BLOCKED: Record<HostName, Record<string, readonly AppNeed[]>> = {
  // The three the web shelf has always locked — now each for its own reason.
  web: { hue: ['lan'], 'trade-copilot': ['native-fetch'], whatsapp: ['helper'] },
  desktop: {},
  artifact: {
    github: ['network'],
    gmail: ['network', 'oauth'],
    hue: ['lan'],
    ledger: ['network'],
    spotify: ['network', 'oauth'],
    'trade-copilot': ['network', 'native-fetch'],
    weather: ['network'],
    whatsapp: ['helper'],
  },
  file: {
    github: ['network'],
    gmail: ['network', 'oauth'],
    hue: ['lan'],
    ledger: ['network'],
    spotify: ['network', 'oauth'],
    'trade-copilot': ['network', 'native-fetch'],
    weather: ['network'],
    whatsapp: ['helper'],
  },
  // The process carries the request, so Coinbase's missing CORS is no wall here.
  runner: { hue: ['lan'], whatsapp: ['helper'] },
  // The fixed sign-in port was taken: the two OAuth starters go, the key-based ones stay.
  'runner, oauthRedirect:false': { gmail: ['oauth'], hue: ['lan'], spotify: ['oauth'], whatsapp: ['helper'] },
};

/** Where an app with these needs runs, most capable first. */
const RUNS_IN: Record<string, readonly RunsIn[]> = {
  github: ['desktop', 'runner', 'web'],
  gmail: ['desktop', 'runner', 'web'],
  hue: ['desktop'],
  ledger: ['desktop', 'runner', 'web'],
  spotify: ['desktop', 'runner', 'web'],
  'trade-copilot': ['desktop', 'runner'],
  weather: ['desktop', 'runner', 'web'],
  whatsapp: ['desktop'],
};

const requirement = (over: Partial<ConnectionRequirement> & Pick<ConnectionRequirement, 'kind'>): ConnectionRequirement =>
  ({ slot: 'x', provider: { name: 'Example API' }, declaredApiHosts: ['api.example.test'], ...over }) as ConnectionRequirement;

describe('needsOfRequirement — what one declared connection asks of its host', () => {
  it('an app that declares nothing needs nothing', () => {
    expect(needsOfRequirement(undefined)).toEqual([]);
  });

  it('every credential kind reached over the internet needs the network', () => {
    for (const kind of ['api_key', 'bearer_token', 'basic_auth', 'none'] as const) {
      expect(needsOfRequirement(requirement({ kind })), kind).toEqual(['network']);
    }
  });

  it('an OAuth requirement also needs the redirect to come back', () => {
    expect(needsOfRequirement(requirement({ kind: 'oauth2_auth_code' }))).toEqual(['network', 'oauth']);
  });

  it('a LAN requirement needs the home network and nothing else — collected address or not', () => {
    const lanHost = { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' } as const;
    const bare = { slot: 'hue', provider: { name: 'Philips Hue' }, kind: 'api_key', lanHost } as ConnectionRequirement;
    expect(needsOfRequirement(bare)).toEqual(['lan']);
    expect(needsOfRequirement({ ...bare, declaredApiHosts: ['192.168.1.50'] })).toEqual(['lan']);
  });

  it('a linked device needs the helper and nothing else', () => {
    expect(needsOfRequirement(requirement({ kind: 'linked_device', provider: { name: 'WhatsApp' } }))).toEqual(['helper']);
  });

  it('native-fetch is TRI-STATE: only a reviewed `browserCallable: false` earns it', () => {
    // Coinbase: reviewed false. GitHub: reviewed true. Spotify: no seat. "Example API": no entry.
    expect(needsOfRequirement(requirement({ kind: 'api_key', provider: { name: 'Coinbase' } }))).toEqual(['network', 'native-fetch']);
    expect(needsOfRequirement(requirement({ kind: 'bearer_token', provider: { name: 'GitHub' } }))).toEqual(['network']);
    expect(needsOfRequirement(requirement({ kind: 'oauth2_auth_code', provider: { name: 'Spotify' } }))).toEqual(['network', 'oauth']);
    expect(needsOfRequirement(requirement({ kind: 'api_key', provider: { name: 'Example API' } }))).toEqual(['network']);
  });
});

describe('needsOfConnections — an installed app, from its rows', () => {
  const row = (status: 'declared' | 'approved' | 'revoked', req: ConnectionRequirement) => ({ appId: 'app-1', slot: req.slot, status, requirement: req });
  const coinbase = requirement({ kind: 'api_key', provider: { name: 'Coinbase' } });
  const spotify = requirement({ kind: 'oauth2_auth_code', slot: 'spotify', provider: { name: 'Spotify' } });
  /** No row has finished a sign-in — the reading every row got before Gate 5 seams/F1. */
  const nobody = (): boolean => false;
  const everybody = (): boolean => true;

  it('an app with no row needs nothing', () => {
    expect(needsOfConnections([], nobody)).toEqual([]);
  });

  it('declared and approved rows count; a revoked row does not', () => {
    expect(needsOfConnections([row('declared', coinbase)], nobody)).toEqual(['network', 'native-fetch']);
    expect(needsOfConnections([row('approved', coinbase)], nobody)).toEqual(['network', 'native-fetch']);
    expect(needsOfConnections([row('revoked', coinbase)], nobody)).toEqual([]);
  });

  it('several rows are a union, each need once, in the order a tile reads them', () => {
    expect(needsOfConnections([row('approved', spotify), row('declared', coinbase), row('revoked', requirement({ kind: 'linked_device' }))], nobody)).toEqual([
      'network',
      'native-fetch',
      'oauth',
    ]);
  });

  it('the sign-in is a need only while it is OWED: an approved row whose sign-in finished needs the network, not the redirect', () => {
    // Gate 5 seams/F1. Running an app on its stored tokens needs the network; the redirect
    // is needed to SIGN IN. Counted for every OAuth row, a runner that lost its fixed port
    // (`oauthRedirect: false`) blocked every app the user had already connected — with a
    // reason that was false for them.
    expect(needsOfConnections([row('approved', spotify)], everybody)).toEqual(['network']);
    expect(needsOfConnections([row('approved', spotify)], nobody)).toEqual(['network', 'oauth']);
    // A declared row still owes it whatever is stored: approval comes before any sign-in.
    expect(needsOfConnections([row('declared', spotify)], everybody)).toEqual(['network', 'oauth']);
    // The reader is asked about THIS row, by app and slot.
    const asked: string[] = [];
    needsOfConnections([row('approved', spotify)], (r) => (asked.push(`${r.appId}/${r.slot}`), true));
    expect(asked).toEqual(['app-1/spotify']);
  });
});

describe('signedIn — has a row’s provider sign-in happened? Read from what the OAuth service stores', () => {
  // The service's own precondition for running on stored tokens (packages/auth
  // `OAuthService.getAccessToken`): a connection state that is not `pending`, and an access
  // token, both in the SLOT's slice. These rows are written through the store classes the
  // wizard hands the service (`SlotScopedCredentialStore` over `UserDbCredentialStore`).
  async function db() {
    const helper = await import('./userdbTestHelper.js');
    return helper.installTestUserDb();
  }
  const signIn = async (userDb: Awaited<ReturnType<typeof db>>, appId: string, slot: string, state: { status: 'pending' | 'connected' | 'expired' | 'error' } | 'corrupt', token = true) => {
    const { SlotScopedCredentialStore, UserDbCredentialStore } = await import('@snugprotocol/auth');
    const store = new SlotScopedCredentialStore(new UserDbCredentialStore(userDb), slot);
    if (token) await store.setCredential(appId, 'access_token', 'at-from-the-provider');
    if (state === 'corrupt') userDb.setSecret(`auth:${appId}:${slot}:_connection`, '{not json');
    else await store.setConnectionState(appId, { ...state, obtainedAt: Date.now(), expiresIn: 3600 });
  };

  it('a finished sign-in (connected, or expired — the service refreshes over the network) is signed in', async () => {
    const userDb = await db();
    await signIn(userDb, 'app-1', 'spotify', { status: 'connected' });
    await signIn(userDb, 'app-2', 'spotify', { status: 'expired' });
    const reader = signedIn(userDb);
    expect(reader({ appId: 'app-1', slot: 'spotify' })).toBe(true);
    expect(reader({ appId: 'app-2', slot: 'spotify' })).toBe(true);
  });

  it('owed: nothing stored, a sign-in still pending (even over an old token), no token, a corrupt state, another slot’s token', async () => {
    const userDb = await db();
    await signIn(userDb, 'pending', 'spotify', { status: 'pending' });
    await signIn(userDb, 'tokenless', 'spotify', { status: 'connected' }, false);
    await signIn(userDb, 'corrupt', 'spotify', 'corrupt');
    await signIn(userDb, 'other-slot', 'gmail', { status: 'connected' });
    const reader = signedIn(userDb);
    for (const appId of ['nothing', 'pending', 'tokenless', 'corrupt', 'other-slot']) expect(reader({ appId, slot: 'spotify' }), appId).toBe(false);
  });

  it('never reads a credential’s VALUE — only whether it is there', async () => {
    const userDb = await db();
    await signIn(userDb, 'app-1', 'spotify', { status: 'connected' });
    const read: string[] = [];
    const watched = { getSecret: (key: string) => (read.push(key), userDb.getSecret(key)), listSecretKeys: () => userDb.listSecretKeys() };
    expect(signedIn(watched)({ appId: 'app-1', slot: 'spotify' })).toBe(true);
    expect(read).toEqual(['auth:app-1:spotify:_connection']);
  });
});

describe('offersOf — read from seats the platform already carries, never from `kind`', () => {
  const base = (over: Partial<SnugPlatform> = {}): SnugPlatform => ({
    kind: 'web',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false },
    ...over,
  });
  const fn = (async () => new Response('')) as never;

  it('a bare platform offers the network and a sign-in, and nothing a seat would carry', () => {
    expect(offersOf(base())).toEqual(HOSTS.web);
  });

  it('`kind` decides NOTHING: a seatless "desktop" offers what the web does', () => {
    expect(offersOf(base({ kind: 'desktop' }))).toEqual(HOSTS.web);
    expect(offersOf(base({ kind: 'host' }))).toEqual(HOSTS.web);
  });

  it('connections switched off → no network and no sign-in', () => {
    const off = base({ capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, connections: false } });
    expect(offersOf(off)).toEqual(NOTHING);
  });

  it('`fetchImpl` is the native-fetch offer', () => {
    expect(offersOf(base({ fetchImpl: fn }))['native-fetch']).toBe(true);
  });

  it('`oauthRedirect: false` withdraws the sign-in alone', () => {
    const taken = base({
      fetchImpl: fn,
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, connections: true, oauthRedirect: false },
    });
    expect(offersOf(taken)).toEqual(HOSTS['runner, oauthRedirect:false']);
  });

  it('the LAN offer needs BOTH seats — a pinned transport with no pairing (or the reverse) is half a flow', () => {
    expect(offersOf(base({ lanFetch: fn })).lan).toBe(false);
    expect(offersOf(base({ lanPair: fn })).lan).toBe(false);
    expect(offersOf(base({ lanFetch: fn, lanPair: fn })).lan).toBe(true);
  });

  it('the helper offer needs all THREE sidecar seats', () => {
    expect(offersOf(base({ sidecarCtl: fn, sidecarFetch: fn })).helper).toBe(false);
    expect(offersOf(base({ sidecarCtl: fn, sidecarWizardFetch: fn })).helper).toBe(false);
    expect(offersOf(base({ sidecarFetch: fn, sidecarWizardFetch: fn })).helper).toBe(false);
    expect(offersOf(base({ sidecarCtl: fn, sidecarFetch: fn, sidecarWizardFetch: fn })).helper).toBe(true);
  });
});

describe('availabilityOf — the verdict and its words', () => {
  it('needs the host meets → ok, with no blocker to read', () => {
    expect(availabilityOf([], NOTHING)).toEqual({ ok: true });
    expect(availabilityOf(['network', 'oauth'], HOSTS.web)).toEqual({ ok: true });
  });

  it('each need has its own title and sentence — the tile and the route read these', () => {
    const titles = Object.fromEntries(
      (['network', 'native-fetch', 'oauth', 'lan', 'helper'] as const).map((need) => {
        const verdict = availabilityOf([need], NOTHING);
        if (verdict.ok) throw new Error(`${need} must be blocked where nothing is offered`);
        expect(verdict.blockers).toHaveLength(1);
        expect(verdict.blockers[0]!.need).toBe(need);
        expect(verdict.blockers[0]!.sentence.length, `${need} sentence`).toBeGreaterThan(20);
        return [need, verdict.blockers[0]!.title];
      }),
    );
    expect(titles).toEqual({
      network: 'needs live connections',
      'native-fetch': 'needs more than a browser',
      oauth: 'needs a provider sign-in',
      lan: 'needs your home network',
      helper: 'needs the phone helper',
    });
  });

  it('the network blocker says the ONE "connections aren’t available" sentence', () => {
    const verdict = availabilityOf(['network'], NOTHING);
    expect(CONNECTIONS_UNAVAILABLE).toBe('connections aren’t available in this host');
    expect(!verdict.ok && verdict.blockers[0]!.sentence).toContain(CONNECTIONS_UNAVAILABLE);
  });

  it('`runsIn` is judged on the app’s WHOLE need set — a browser cannot run an app whose provider refuses browsers', () => {
    // Under an artifact Trade Copilot's FIRST blocker is the network; "runs in the web
    // playground" would still be false, because native-fetch is missing there too.
    const verdict = availabilityOf(['network', 'native-fetch'], NOTHING);
    if (verdict.ok) throw new Error('blocked');
    for (const blocker of verdict.blockers) expect(blocker.runsIn).toEqual(['desktop', 'runner']);
  });

  it('… the WHOLE set, not the missing one: a host that meets part of it must not shrink what `runsIn` is judged on', () => {
    // The case above cannot tell the two apart — where nothing is offered, the missing set IS
    // the need set (the round-2 verifier's surviving mutant, 2026-10-03). Here they differ:
    // the runner whose sign-in port was taken meets the network and the native fetch, so
    // `oauth` is the ONE blocker. Judged on that blocker alone, every host that signs in
    // would be listed — the web playground among them, for an app whose provider refuses
    // browsers. No shipped starter has this need set, so the matrix cannot see it either.
    const verdict = availabilityOf(['network', 'native-fetch', 'oauth'], HOSTS['runner, oauthRedirect:false']);
    if (verdict.ok) throw new Error('blocked');
    expect(verdict.blockers.map((blocker) => blocker.need)).toEqual(['oauth']);
    expect(verdict.blockers[0]!.runsIn).toEqual(['desktop', 'runner']);
  });

  it('every place an app can run has a name a person would use', () => {
    expect(RUNS_IN_LABEL).toEqual({ desktop: 'Snug for Mac', runner: 'your agent’s plugin', web: 'the web playground' });
  });
});

describe('the matrix — twelve starters × every host', () => {
  const source = starterSource();
  const folders = source.appFolders();

  it('covers exactly the shipped starters (a new folder must be given a row)', () => {
    expect(folders).toEqual(Object.keys(NEEDS).sort((a, b) => a.localeCompare(b)));
    expect(folders).toHaveLength(12);
  });

  it('reads each starter’s needs from its own connection.json, synchronously', () => {
    for (const folder of folders) {
      expect(needsOfRequirement(source.requirement(folder)), folder).toEqual(NEEDS[folder]);
    }
  });

  it('the shelf’s needs equal the needs of the row the install act would copy', async () => {
    // `requirement()` is the manifest as declared; install copies the ADMITTED requirement
    // (registry substitution, starterDeclaration.ts). A manifest that named its provider by
    // an alias would make the two disagree — a tile enabled over a copy that is blocked.
    for (const folder of folders) {
      const admitted = await starterDeclarationForStarterId(`${STARTER_PREFIX}${folder}`);
      expect(needsOfRequirement(admitted ?? undefined), folder).toEqual(needsOfRequirement(source.requirement(folder)));
    }
  });

  for (const host of Object.keys(HOSTS) as HostName[]) {
    it(`${host}: disables exactly its blocked starters, each for its own reason`, () => {
      const blocked: Record<string, AppNeed[]> = {};
      for (const folder of folders) {
        const verdict = availabilityOf(needsOfRequirement(source.requirement(folder)), HOSTS[host]);
        if (verdict.ok) continue;
        blocked[folder] = verdict.blockers.map((blocker) => blocker.need);
        for (const blocker of verdict.blockers) {
          expect(blocker.runsIn, `${folder} on ${host}`).toEqual(RUNS_IN[folder]);
          expect(blocker.runsIn.length).toBeGreaterThan(0);
        }
      }
      expect(blocked).toEqual(BLOCKED[host]);
    });
  }

  it('gmail stays enabled on the web (ADR-0049 dual mode)', () => {
    expect(availabilityOf(needsOfRequirement(source.requirement('gmail')), HOSTS.web)).toEqual({ ok: true });
  });
});

describe('the shells, through their REAL platform objects', () => {
  it('the web default offers exactly what the matrix calls `web`', async () => {
    vi.resetModules();
    const { getPlatform } = await import('../platform/platform.js');
    expect(getPlatform().kind).toBe('web');
    expect(offersOf(getPlatform())).toEqual(HOSTS.web);
  });

  it('the table `runsIn` is judged against holds exactly these three hosts, with these offers', () => {
    // The desktop and runner halves are proven against createDesktopPlatform and
    // composeLocalPlatform in their own packages (apps/desktop, apps/host).
    expect(HOST_OFFERS).toEqual({ desktop: HOSTS.desktop, runner: HOSTS.runner, web: HOSTS.web });
  });
});

// ------------------------------------------------------------------- S4: the source lint

/** Comments out, strings kept: a read inside a template literal (`${platform.kind}`) is still a read. */
function stripComments(source: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') walk(path, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * A read of the PLATFORM's kind. Four spellings, ONE match per read:
 *  - `getPlatform().kind`, `platform.kind`, or a destructure of it — by the name it is read through;
 *  - ANY `.kind` compared with `'desktop'` or `'web'` — by what it is compared with, so a read
 *    through another local name (`const p = getPlatform(); if (p.kind !== 'desktop')`) cannot
 *    slip past. Those two values exist in no other `kind` union in this source (the brain's is
 *    `demo | host`), so this arm cannot fire on `brain.kind === 'host'`.
 * The value arm is LAST on purpose: at `getPlatform().kind !== 'desktop'` the name arm has
 * already consumed `.kind`, so the read is counted once and the allowlist's counts stay exact.
 */
const PLATFORM_KIND_READ =
  /getPlatform\(\)\s*\??\.\s*kind\b|\bplatform\s*\??\.\s*kind\b|\{[^{}]*\bkind\b[^{}]*\}\s*=\s*getPlatform\(\)|\.\s*kind\s*[!=]==?\s*['"`](?:desktop|web)['"`]/g;

/**
 * THE NAMED ALLOWLIST. Every read of the platform's kind in playground source, with how many
 * and why none of them decides what an app or a connection can do. A count, not a pattern:
 * a second read added to an allowed file fails here just as a read in a new file does.
 */
const ALLOWED_KIND_READS: Record<string, { reads: number; why: string }> = {
  'desktop/firstRun.ts': { reads: 1, why: 'the desktop welcome latch — a first-run screen, not a capability' },
  'views/DownloadView.tsx': { reads: 1, why: 'presentation: "you are already running the desktop app"' },
  'run/RunView.tsx': { reads: 1, why: 'the "open in Snug for Mac" offer on a macOS browser (ADR-0021 D8)' },
  'agent/builder.ts': { reads: 1, why: 'the prompt’s platform layer — tells the model where it is' },
  'agent/transport.ts': { reads: 1, why: 'the prompt’s platform layer — tells the model where it is' },
  'agent/connectionInferrerAdapter.ts': { reads: 1, why: 'the prompt’s platform layer — tells the model where it is' },
  'feedback/environment.ts': { reads: 2, why: 'the feedback report’s environment line' },
  'views/SettingsView.tsx': { reads: 1, why: 'presentation: the kit’s storage disclosure line' },
  'run/LlmInspectorPanel.tsx': { reads: 1, why: 'presentation: which copy the inspector’s export note uses' },
  'views/BrainChip.tsx': { reads: 1, why: 'presentation: the demo brain’s host wording' },
  'views/AvailabilityNote.tsx': { reads: 1, why: 'presentation of a verdict ALREADY taken: the web shelf keeps its "desktop" badge' },
  'views/HostPassport.tsx': { reads: 1, why: 'the passport renders on host platforms only (web and desktop show nothing new)' },
  'schedule/honesty.ts': { reads: 1, why: 'presentation: the honesty line names the host ("this tab" / "Snug for Mac") — disclosure of what the seats already decided, never a capability (TASK-20261009 E9)' },
  'schedule/scheduler.ts': { reads: 1, why: 'the run row RECORDS which host ran it (`host: {kind, binding}`) — a record of where, never a decision about what may run (TASK-20261009 E9; the honesty line reads through honesty.ts)' },
};

describe('S4 — no capability decision in playground source reads the platform’s kind', () => {
  const src = join(process.cwd(), 'src');
  const reads = new Map<string, number>();
  for (const file of walk(src)) {
    const count = stripComments(readFileSync(file, 'utf8')).match(PLATFORM_KIND_READ)?.length ?? 0;
    if (count > 0) reads.set(relative(src, file), count);
  }

  it('every read of the platform’s kind is on the named allowlist, with its exact count', () => {
    const found = Object.fromEntries([...reads].sort(([a], [b]) => a.localeCompare(b)));
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED_KIND_READS)
        .map(([file, entry]) => [file, entry.reads] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(found, 'a capability decision belongs in platform/availability.ts (offersOf), which reads seats').toEqual(allowed);
  });

  it('the derivation itself never reads it', () => {
    expect(reads.has('platform/availability.ts')).toBe(false);
  });

  it('the lint sees through comments and into template literals', () => {
    expect(stripComments("a // getPlatform().kind\nb /* platform.kind */ c").match(PLATFORM_KIND_READ)).toBeNull();
    expect(stripComments('const url = "https://x.test"; if (getPlatform().kind !== "desktop") {}').match(PLATFORM_KIND_READ)).toHaveLength(1);
    expect(stripComments('`${platform.kind === "desktop" ? "a" : "b"}`').match(PLATFORM_KIND_READ)).toHaveLength(1);
    expect(stripComments('const { kind } = getPlatform();').match(PLATFORM_KIND_READ)).toHaveLength(1);
    // A read through ANOTHER local name is caught by what it is compared with …
    expect(stripComments("const p = getPlatform(); if (p.kind !== 'desktop') {}").match(PLATFORM_KIND_READ)).toHaveLength(1);
    expect(stripComments('const locked = host?.kind === "web";').match(PLATFORM_KIND_READ)).toHaveLength(1);
    // … and a read both arms could claim is still ONE read, or the allowlist's counts would lie.
    expect(stripComments("if (getPlatform().kind !== 'desktop' && platform.kind === 'web') {}").match(PLATFORM_KIND_READ)).toHaveLength(2);
    // The BRAIN's kind is a different union and is not a platform read.
    expect(stripComments("if (brain.kind === 'host' || pinned?.kind === 'host') {}").match(PLATFORM_KIND_READ)).toBeNull();
  });
});

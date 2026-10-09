#!/usr/bin/env node
// The desktop-host walk (TASK-20261003 D5): the plugin AS SHIPPED, started the way a desktop
// app starts it, taken through one Chess move on the user's real brain — and then again with
// every brain hidden.
//
//   node scripts/walk-desktop-host.mjs [--no-brain]
//
// OPT-IN, AND IN NO GATE. Leg 1 spends the user's own subscription: the brain's readiness
// check is a real (tiny) think and the Chess move is another. A person runs this; no test,
// gate or script does, and its own tests never start it — they drive its parts against a
// fake launcher. It builds nothing: it walks `dist/plugin` as the last build left it, and
// its report says which commit that was.
//
// WHY A WALK. Every machine-run proof of the runner stops short of this. The gate's launch
// legs start the shipped launcher, but under a temp HOME — no CLI login, so never a brain.
// The unit suites inject fake drivers; the browser specs run the TEST entry with fake
// brains. Nothing shows the shipped process, under the environment a GUI gives it (no user
// PATH — `launchctl getenv PATH` was empty on the owner's Mac, 2026-09-13), finding Node,
// finding the user's CLI and its login, and answering an app's think; or what a user sees
// when there is no CLI to find.
//
//   leg 1  `brain`     an explicit environment — the REAL HOME (the CLI's login lives
//                      there), USER, TMPDIR, PATH=/usr/bin:/bin:/usr/sbin:/sbin and
//                      SNUG_HOME=<a fresh temp dir> — cwd `/` → MCP initialize, tools/list,
//                      snug_status → the launch address from the runner's own control
//                      socket → Chess handed in over MCP → the real page in Chromium: open
//                      Chess, ONE move, the reply.
//   leg 2  `no-brain`  the same with HOME=<an empty temp dir>, so no login and no install
//                      root resolves → the chip names the remedy, the demo brain answers
//                      the move, and nothing is answered 502. This leg spends nothing: it
//                      moves only once the page says the demo brain is what will answer.
//
// THE ISOLATION CONTRACT — the gate's, for a process that is handed the real HOME:
//   · the launcher gets five variables and nothing of this shell's;
//   · SNUG_HOME always wins over HOME in the process (`apps/host-mcp/src/home.ts`), so the
//     user's `~/Snug` is never read or written — and `walkEnv` will not build an
//     environment that names it;
//   · the FIRST thing believed about the started process is that its status names the
//     walk's own temp home, a file under it, and the pid of the child the walk spawned.
//     Anything else and the leg stops there;
//   · one control socket is ever spoken to, the one under that temp home, and it is asked
//     two things: who it is, and its launch address. It is never asked to stop or to open;
//   · one process is ever signalled: that child, through its own handle;
//   · the launch address carries the bearer. It is held in memory, given to the browser, and
//     never printed — every line of the report passes through `scrubBearer`.
//
// Dependency-free node builtins, like every other script here. Playwright is the one
// `apps/host` already has for its browser specs, loaded from there: nothing is added.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLUGIN_OUT_DIR } from './build-plugin.mjs';
import { DEFAULT_EXAMPLES_DIR, readStarter } from './build-starters-pkg.mjs';
import { startLauncher } from './check-host-mcp.mjs';
import { LAUNCHER_PATH, PLUGIN } from './lib/plugin-manifests.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------- the arguments

export const USAGE = [
  'Usage: node scripts/walk-desktop-host.mjs [--no-brain]',
  '',
  'Walks the built plugin (dist/plugin) as a desktop app would start it: one Chess move on',
  'your real brain, then the same with every brain hidden. It builds nothing.',
  '',
  '  (no argument)  both legs. Leg 1 makes real calls on your own subscription: the brain’s',
  '                 readiness check and one Chess move.',
  '  --no-brain     only leg 2, which spends nothing.',
].join('\n');

/** What the walk needs built, and how: it never builds for itself. */
export const BUILD_COMMAND = 'pnpm build && node scripts/build-plugin.mjs';

/**
 * @param {readonly string[]} argv
 * @returns {{ legs: ('brain' | 'no-brain')[] } | { help: true } | { error: string }}
 */
export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  // A typo must never fall through to "both legs": that is the one that spends.
  const stray = argv.find((arg) => arg !== '--no-brain');
  if (stray !== undefined) return { error: `unknown argument: ${JSON.stringify(stray)}` };
  return { legs: argv.includes('--no-brain') ? ['no-brain'] : ['brain', 'no-brain'] };
}

// ------------------------------------------------------------------- the isolation contract

/**
 * A desktop app's PATH for the processes it spawns: the system's four directories, and
 * nothing a shell profile adds — no nvm, no Homebrew. That the launcher finds a Node and
 * the runner finds the user's CLI from HERE is what leg 1 exists to show.
 */
export const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Is `target` strictly inside `dir`? By path arithmetic, so `..` and a shared prefix do not pass. */
function inside(target, dir) {
  const relative = path.relative(dir, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The environment a leg's launcher gets — these five variables, built from what it is
 * handed and never from this process's own environment (no key, no token, no PATH of ours).
 *
 * It REFUSES a `snugHome` that is `<home>/Snug` or inside it. The release bundle is the one
 * build allowed to resolve the user's real home (D-B34), and with the real HOME in the
 * environment SNUG_HOME is all that stands between a walk and a second writer on the user's
 * file (lessons 2026-09-07/08).
 *
 * @param {{ home: string, user: string, tmp: string, snugHome: string, nodeDir?: string }} from
 *   `nodeDir` — leg 2 only: a directory holding `node` and nothing else, put first on the
 *   PATH. An empty HOME hides every install root under it, which on a machine whose Node is
 *   an nvm install hides Node too; this lets the process start while no CLI resolves.
 */
export function walkEnv({ home, user, tmp, snugHome, nodeDir }) {
  if (typeof snugHome !== 'string' || !path.isAbsolute(snugHome)) {
    throw new Error(`refusing to start a runner: SNUG_HOME must be an absolute temp directory, and it is ${JSON.stringify(snugHome)}`);
  }
  const real = path.join(home, 'Snug');
  const named = path.resolve(snugHome);
  if (named === real || inside(named, real)) throw new Error(`refusing to start a runner: SNUG_HOME (${snugHome}) is the real Snug home of ${home}`);
  return { HOME: home, USER: user, TMPDIR: tmp, PATH: nodeDir === undefined ? GUI_PATH : `${nodeDir}:${GUI_PATH}`, SNUG_HOME: snugHome };
}

/**
 * Why a `snug_status` answer is NOT from the walk's own runner — empty when it is. "Mine"
 * is: running, leading (not attached to somebody else's), on exactly the home the walk
 * made, keeping its file under that home, and being the child the walk spawned.
 *
 * @param {unknown} status what `snug_status` answered
 * @param {{ snugHome: string, pid: number | undefined }} own
 * @returns {string[]}
 */
export function whyNotMine(status, { snugHome, pid }) {
  if (typeof status !== 'object' || status === null || status.running !== true) {
    const refusal = status?.refusal;
    return [typeof refusal?.code === 'string' ? `the runner is not running — ${refusal.code}: ${refusal.message} (${refusal.remedy})` : 'the runner is not running'];
  }
  const problems = [];
  if (status.attached === true) problems.push(`it attached to another runner (pid ${JSON.stringify(status.pid)}) instead of leading`);
  if (status.home !== snugHome) problems.push(`its home is ${JSON.stringify(status.home)}, not the walk’s ${snugHome}`);
  if (typeof status.file !== 'string' || !inside(status.file, snugHome)) problems.push(`its file is ${JSON.stringify(status.file)}, which is not under ${snugHome}`);
  if (typeof pid !== 'number' || status.pid !== pid) problems.push(`pid ${JSON.stringify(status.pid)} is not the child the walk started (${pid})`);
  return problems;
}

/**
 * The one address the walk opens: its own runner's, on loopback, with its token. Anything
 * else is refused — in words that never repeat what was given, which may carry a bearer.
 *
 * @returns {{ url: string, origin: string, token: string }}
 */
export function launchTarget(url, port) {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]{64})$/.exec(typeof url === 'string' ? url : '');
  if (match === null || Number(match[1]) !== port) {
    throw new Error(`the runner’s launch address is not http://127.0.0.1:${port}/ with its token — the walk opens nothing else`);
  }
  return { url, origin: `http://127.0.0.1:${port}`, token: match[2] };
}

/** Take the bearer out of a text: by value when it is known, and by the launch address's shape. */
export function scrubBearer(text, token) {
  const byValue = typeof token === 'string' && token !== '' ? text.split(token).join('[bearer]') : text;
  return byValue.replace(/([#&?]token=)[0-9a-f]+/gi, '$1[bearer]');
}

// ------------------------------------------------------------------- what is handed in

/** One lineage for the walk's Chess: every leg installs it into a home of its own. */
export const WALK_LINEAGE = '0d5c7a1e-de57-4c0d-9a1b-3a5e5b0c4e55';

/** `examples/chess` as the starters package reads it: the app's html and its runtime contract. */
export function readChess() {
  const starter = readStarter(DEFAULT_EXAMPLES_DIR, 'chess', PLUGIN.version);
  return { html: starter.html, contract: JSON.parse(starter.contract) };
}

/** Chess as the `snug-app-bundle/1` an agent would hand in: the whole app, its contract, no connection. */
export function chessBundle({ html, contract, sharedAt }) {
  return {
    format: 'snug-app-bundle/1',
    lineage: WALK_LINEAGE,
    sharedAt,
    app: { displayName: 'Chess', description: 'Play chess against the agent', iconEmoji: '♟️', usesDb: true },
    html,
    contract,
    connections: [],
  };
}

// ------------------------------------------------------------------- the verdict and the report

/** What a remedy says: where to get the CLI, or the command that mends the one that is there. */
const REMEDY = /install Claude Code|code\.claude\.com|\/login|claude update/i;

/** Does this text tell a person what to DO about a brain that is not ready? */
export const namesRemedy = (text) => typeof text === 'string' && REMEDY.test(text);

/** The lazy readiness check of a real CLI: a spawn and one tiny think (its own bound is 20 s). */
const BRAIN_READY_BOUND_MS = 60_000;
/** One Chess move on a cold child; every bound the brain keeps for itself is inside this. */
const THINK_BOUND_MS = 120_000;

/**
 * What a leg's observations amount to: its problems, none when it passed. The walk records
 * and this judges — apart, so every way a leg can fail is shown to fail without a browser
 * or a brain.
 *
 * @param {'brain' | 'no-brain'} leg
 * @param {{ ready: boolean, active: string | null, moved: boolean, handIn?: string, reply?: { ms: number } | { failed: string },
 *   chip: { text: string, brain: string | null }, saidDemo: boolean, remedy?: string,
 *   chat: { status: number, brain: string | null }[], pageErrors: string[] }} seen
 *   `ready` — a brain became ready in time (leg 1 waits for one); `moved` — the leg made its
 *   move (leg 2 does not while a brain could take the think); `reply` — absent when the
 *   move went unanswered
 * @returns {string[]}
 */
export function judge(leg, seen) {
  const problems = [];
  if (leg === 'brain' && !seen.ready) problems.push(`no brain became ready within ${BRAIN_READY_BOUND_MS / 1000} s of the page opening`);
  if (!seen.moved) {
    problems.push(
      `the brain was NOT hidden (auto → ${seen.active ?? 'none'}, the chip says “${seen.chip.text}”), so no move was made. ` +
        'Is a CLI installed outside HOME (/opt/homebrew/bin, /usr/local/bin)?',
    );
  } else {
    if (!(seen.handIn ?? '').startsWith('installed "Chess"')) problems.push(`snug_hand_in did not install Chess: ${seen.handIn}`);
    if (seen.reply === undefined) problems.push(`the move was not answered within ${THINK_BOUND_MS / 1000} s`);
    else if ('failed' in seen.reply) problems.push(`the think failed — the app says: ${seen.reply.failed}`);
  }
  if (leg === 'brain') {
    const answered = seen.reply !== undefined && 'ms' in seen.reply;
    if (seen.saidDemo) problems.push(`the page said demo — the real brain did not answer (the chip says “${seen.chip.text}”)`);
    if (answered && !seen.chat.some((answer) => answer.status === 200)) problems.push('the move was answered, but no think reached the runner’s brain');
    if (seen.chat.some((answer) => answer.status === 200 && answer.brain === null)) problems.push('the runner answered a think without saying which brain did (no x-snug-brain header)');
    for (const answer of seen.chat.filter((each) => each.status !== 200)) problems.push(`the runner answered a think with HTTP ${answer.status}`);
  } else if (seen.moved) {
    if (!seen.saidDemo) problems.push(`the page did not say demo (the chip says “${seen.chip.text}”)`);
    if (!namesRemedy(seen.remedy)) problems.push(`the chip does not name a remedy — it says: “${seen.remedy}”`);
    // With no brain ready the page's demo brain answers and nothing is sent to a brain that
    // is not there. A 502 is the bare failure this leg exists to never see again.
    if (seen.chat.some((answer) => answer.status === 502)) problems.push('a think was answered 502 — with no brain ready the demo brain must answer');
  }
  for (const message of seen.pageErrors) problems.push(`the page threw: ${message}`);
  return problems;
}

const LEG_TITLES = { brain: 'leg 1 · the real brain', 'no-brain': 'leg 2 · no brain' };
const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const yesNo = (flag) => (flag === true ? 'yes' : 'no');

/** A leg in lines: only what it measured — one that aborted early says its problem and nothing invented. */
function legLines(leg) {
  const { runner, ms = {} } = leg;
  const lines = [`${LEG_TITLES[leg.leg] ?? leg.leg} — ${leg.ok ? 'PASS' : 'FAIL'}`];
  if (runner !== undefined) {
    lines.push(
      `  runner   Snug ${runner.version} (build ${runner.build}, ${runner.platform}) pid ${runner.pid}, port ${runner.port} · ` +
        `initialize ${count(ms.initialize)} ms · snug_status ${count(ms.status)} ms`,
    );
  }
  if (leg.handIn !== undefined) lines.push(`  hand-in  ${leg.handIn}`);
  if (leg.brains !== undefined) {
    const each = leg.brains.map((brain) => `${brain.id} ${brain.state}${brain.verified === false ? ' (unverified)' : ''}`);
    const ready = ms.brainReady !== undefined ? [`ready after ${count(ms.brainReady)} ms`] : [];
    lines.push(`  brains   ${[...each, `auto → ${leg.active ?? 'none'}`, ...ready].join(' · ')}`);
  }
  if (ms.think !== undefined) {
    lines.push(`  think    answered in ${count(ms.think)} ms · x-snug-brain: ${leg.answered?.header ?? 'none'} · answered by: ${leg.answered?.by ?? '—'}`);
  }
  if (leg.chip !== undefined) {
    const sent = (leg.chat ?? []).map((answer) => answer.status).join(', ') || 'none';
    lines.push(`  page     chip “${leg.chip.text}” · said demo: ${yesNo(leg.saidDemo)} · off-script reply: ${yesNo(leg.offScript)} · thinks sent to the runner: ${sent}`);
  }
  if (leg.remedy !== undefined) lines.push(`  remedy   “${leg.remedy}”`);
  for (const problem of leg.problems) lines.push(`  ! ${problem}`);
  return lines;
}

/**
 * The report in its two forms: ONE line of JSON (the journal's record) and a summary a
 * person reads. Both are scrubbed here — the last place a bearer could reach a terminal
 * from, whatever a leg recorded.
 *
 * @returns {{ json: string, summary: string }}
 */
export function formatReport(report) {
  const built = report.plugin.commit !== undefined ? `commit ${report.plugin.commit}, built ${report.plugin.builtAt}` : 'no provenance';
  const summary = [
    `desktop-host walk · ${report.plugin.dir} (${built}) · ${report.at} · ${report.ok ? 'PASS' : 'FAIL'}`,
    ...report.legs.flatMap((leg) => ['', ...legLines(leg)]),
  ].join('\n');
  return { json: scrubBearer(JSON.stringify(report)), summary: scrubBearer(summary) };
}

// ------------------------------------------------------------------- the walk's own runner

/** Whether a control-socket answer is the positive ack of THAT op (`acked` in control-socket.ts). */
const acked = (answer, op) => answer?.ok === true && answer.op === op;

/** One question to a control socket: a JSON line each way, then hang up (control-socket.ts). */
function controlAsk(socket, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let buffer = '';
    const settle = (settled, value) => {
      clearTimeout(timer);
      connection.destroy();
      settled(value);
    };
    const timer = setTimeout(() => settle(reject, new Error(`the runner’s control socket did not answer ${request.op} within ${timeoutMs} ms`)), timeoutMs);
    connection.on('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('error', (error) => settle(reject, new Error(`the runner’s control socket could not be reached (${error.code ?? error.message})`)));
    connection.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        settle(resolve, JSON.parse(buffer.slice(0, newline)));
      } catch {
        settle(reject, new Error(`the runner’s control socket answered ${request.op} with something that is not JSON`));
      }
    });
  });
}

/**
 * Start the shipped launcher and establish — before anything else about it is believed or
 * touched — that the runner answering is the walk's own.
 *
 * Resolves with the session LEFT RUNNING (the caller reaps it). On any failure the child it
 * started is reaped here and the error is thrown: an isolation failure says ISOLATION.
 *
 * @param {{ launcher: string, env: Record<string, string>, requestTimeoutMs?: number, reapMs?: number }} options
 * @returns {Promise<{ session: ReturnType<typeof startLauncher>, status: Record<string, unknown>,
 *   target: { url: string, origin: string, token: string }, ms: { initialize: number, status: number } }>}
 */
export async function startOwnRunner({ launcher, env, requestTimeoutMs = 20_000, reapMs = 8_000 }) {
  const snugHome = env.SNUG_HOME;
  if (typeof snugHome !== 'string' || !path.isAbsolute(snugHome)) throw new Error('refusing to start a runner without an absolute SNUG_HOME of its own');

  const began = performance.now();
  const session = startLauncher(launcher, env, requestTimeoutMs);
  try {
    await session.initialize();
    const initialize = Math.round(performance.now() - began);
    const { tools } = await session.request('tools/list');
    for (const name of ['snug_status', 'snug_hand_in']) {
      if (!tools.some((tool) => tool.name === name)) throw new Error(`tools/list does not carry ${name}`);
    }
    const asked = performance.now();
    const status = await session.status();
    const statusMs = Math.round(performance.now() - asked);

    // THE FIRST ASSERTION, before a socket is opened or a browser started: this is the
    // process the walk spawned, leading on the home the walk made. Anything else means the
    // walk is talking to — or about to open the page of — a Snug it does not own.
    const strange = whyNotMine(status, { snugHome, pid: session.child.pid });
    if (strange.length > 0) throw new Error(`ISOLATION — ${strange.join('; ')}. The walk stopped before touching anything else.`);

    // Its control socket: the one under the home the walk made, and so nobody else's.
    const socket = path.join(snugHome, 'host', 'ctl.sock');
    const hello = await controlAsk(socket, { op: 'hello' }, requestTimeoutMs);
    if (!acked(hello, 'hello') || hello.pid !== session.child.pid) {
      throw new Error(
        `ISOLATION — the control socket under the walk’s home did not answer as the child the walk started (pid ${session.child.pid}): ` +
          `${acked(hello, 'hello') ? `it says pid ${JSON.stringify(hello.pid)}` : 'no ack — an older build?'}. The launch address was not asked for.`,
      );
    }
    // The ONE op that answers the bearer (L5). The walk stands where the human CLI stands:
    // it is the user's own terminal, asking the runner it has just started.
    const launch = await controlAsk(socket, { op: 'launch-url' }, requestTimeoutMs);
    if (!acked(launch, 'launch-url')) throw new Error('the runner’s control socket did not acknowledge the launch address request');
    return { session, status, target: launchTarget(launch.url, status.port), ms: { initialize, status: statusMs } };
  } catch (error) {
    await session.reap(reapMs);
    throw error;
  }
}

// ------------------------------------------------------------------- a leg

/** The hub's first paint and first library read, on a page opened cold. */
const HUB_BOUND_MS = 30_000;
/** How long the page may take to hear of a readiness the runner already reports. */
const CHIP_BOUND_MS = 20_000;
/** An app that loads React and Babel from the CDN before its first render. */
const APP_BOUND_MS = 60_000;
const REAP_MS = 8_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** Poll `read` until it answers something other than `undefined`, or the bound passes. */
async function until(read, boundMs, everyMs = 250) {
  for (const began = performance.now(); ; ) {
    const value = await read();
    if (value !== undefined) return value;
    if (performance.now() - began >= boundMs) return undefined;
    await sleep(everyMs);
  }
}

/** Playwright's Chromium, from the package that already depends on it. */
function loadChromium() {
  return createRequire(path.join(REPO, 'apps/host/package.json'))('@playwright/test').chromium;
}

/** `GET /status` as the page reads it: every brain, and the one a think sent now would run on. */
async function readWire({ origin, token }) {
  const response = await fetch(`${origin}/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`the runner answered GET /status with HTTP ${response.status}`);
  return response.json();
}

/** Leg 2's HOME: a directory with nothing in it — no login, no install root. */
function emptyHome(root) {
  const dir = path.join(root, 'home');
  mkdirSync(dir);
  return dir;
}

/** Leg 2's Node: this script's own, linked alone into a directory (see `walkEnv`). */
function nodeOnlyDir(root) {
  const dir = path.join(root, 'node');
  mkdirSync(dir);
  symlinkSync(process.execPath, path.join(dir, 'node'));
  return dir;
}

/** What a signal must undo for each leg in flight: `finally` does not run on a person's Ctrl-C. */
const inFlight = new Set();

/**
 * One leg, start to finish. Never throws: whatever went wrong is a problem in its result,
 * and its child, its browser and its temp directory are gone when it returns.
 *
 * @param {'brain' | 'no-brain'} leg
 * @param {{ launcher: string, say(line: string): void }} context
 */
async function walkLeg(leg, { launcher, say }) {
  const result = { leg, ok: false, problems: [], ms: {} };
  const root = mkdtempSync(path.join(tmpdir(), 'snug-walk-'));
  let session;
  let browser;
  let token;
  const abandon = () => {
    session?.child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  };
  inFlight.add(abandon);
  try {
    const mine = { user: userInfo().username, tmp: tmpdir(), snugHome: path.join(root, 'snug') };
    const env = leg === 'brain' ? walkEnv({ ...mine, home: homedir() }) : walkEnv({ ...mine, home: emptyHome(root), nodeDir: nodeOnlyDir(root) });

    say(`${leg}: starting the shipped launcher (${leg === 'brain' ? 'your real HOME' : 'an empty HOME'}, SNUG_HOME ${mine.snugHome})`);
    const own = await startOwnRunner({ launcher, env });
    ({ session } = own);
    ({ token } = own.target);
    Object.assign(result.ms, own.ms);
    const { version, build, platform, pid, port } = own.status;
    result.runner = { version, build, platform, pid, port };

    say(`${leg}: opening its page in Chromium`);
    browser = await loadChromium().launch();
    const page = await browser.newPage();
    const chat = [];
    const pageErrors = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/v1/chat/completions') chat.push({ status: response.status(), brain: response.headers()['x-snug-brain'] ?? null });
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(own.target.url);
    const opened = performance.now();
    // The hub is up and its first library read has settled: a fresh home's shelf is empty.
    await page.getByText('nothing here yet').waitFor({ timeout: HUB_BOUND_MS });

    const chip = page.getByTestId('brain-chip');
    const saysDemo = async () => (await chip.getAttribute('data-brain')) === 'demo';
    let wire;
    if (leg === 'brain') {
      // The readiness check is lazy — this page's first contact started it — and a ready
      // CLI answers it with a real think, so `active` arrives seconds after the page does.
      wire = await until(async () => {
        const now = await readWire(own.target);
        return typeof now.active === 'string' ? now : undefined;
      }, BRAIN_READY_BOUND_MS);
      if (wire !== undefined) {
        result.ms.brainReady = Math.round(performance.now() - opened);
        // The page hears of it on its event stream, a moment after the runner knows.
        await until(async () => ((await saysDemo()) ? undefined : true), CHIP_BOUND_MS);
      }
    } else {
      await until(async () => ((await saysDemo()) ? true : undefined), CHIP_BOUND_MS);
    }
    const ready = wire !== undefined;
    wire ??= await readWire(own.target);
    result.active = typeof wire.active === 'string' ? wire.active : null;
    result.brains = (Array.isArray(wire.brains) ? wire.brains : []).map(({ id, state, verified }) => ({ id, state, verified }));

    // Leg 2 SPENDS NOTHING, by construction: it moves only when the runner says no brain
    // would take a think and the page says the demo brain is what answers.
    const moved = leg === 'brain' || (result.active === null && (await saysDemo()));
    let reply;
    if (moved) {
      say(`${leg}: handing Chess in over MCP`);
      const handIn = await session.request('tools/call', { name: 'snug_hand_in', arguments: { bundle: chessBundle({ ...readChess(), sharedAt: new Date().toISOString() }) } });
      result.handIn = handIn.content?.[0]?.text ?? '';

      await page.getByTestId('installed-tile').filter({ hasText: /chess/i }).first().locator('a.tile-link').click();
      // `sandbox="allow-scripts"` is part of the selector: an app frame with any other
      // sandbox is not found, and the leg fails here (C2).
      const app = page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
      await app.getByRole('grid', { name: 'chessboard' }).waitFor({ timeout: APP_BOUND_MS });

      say(`${leg}: one move, e2 to e4${leg === 'brain' ? ' — a real think on your subscription' : ''}`);
      const e4 = app.getByRole('button', { name: /^e4 / });
      await app.getByRole('button', { name: /^e2 / }).click();
      await e4.click();
      const asked = performance.now();
      const turn = app.getByRole('status').first();
      const quiet = app.getByText(/the agent went quiet/);
      reply = await until(
        async () => {
          if ((await quiet.count()) > 0) return { failed: collapse(await quiet.first().innerText()) };
          // White's pawn stands on e4 and it is white's turn again: black has moved. (Both
          // are one render of the app's state, so neither is read ahead of the other.)
          const answered = /your move/.test(await turn.innerText()) && !/ empty$/.test((await e4.getAttribute('aria-label')) ?? '');
          return answered ? { ms: Math.round(performance.now() - asked) } : undefined;
        },
        THINK_BOUND_MS,
        100,
      );
      if (reply !== undefined && 'ms' in reply) result.ms.think = reply.ms;
      // The app's own note when a reply was not a move it could play (the demo brain's always is).
      result.offScript = (await app.getByText(/a legal (one|move) was played/).count()) > 0;
    }

    // What the page says answered — read AFTER the think: the chip names what answered,
    // never what was asked.
    result.chip = { text: collapse(await chip.innerText()), brain: await chip.getAttribute('data-brain') };
    result.saidDemo = result.chip.brain === 'demo' || /\bdemo\b/i.test(result.chip.text);
    await chip.click();
    const menu = page.getByTestId('brain-menu');
    await menu.waitFor({ timeout: 5_000 });
    const answeredBy = page.getByTestId('brain-menu-active');
    result.answered = { header: chat.at(-1)?.brain ?? null, by: (await answeredBy.count()) > 0 ? collapse(await answeredBy.first().innerText()) : null };
    if (leg === 'no-brain') result.remedy = collapse(await menu.innerText());
    result.chat = chat;

    const { active, handIn, chip: chipSaid, saidDemo, remedy } = result;
    result.problems.push(...judge(leg, { ready, active, moved, handIn, reply, chip: chipSaid, saidDemo, remedy, chat, pageErrors }));
  } catch (error) {
    result.problems.push(scrubBearer(error instanceof Error ? error.message : String(error), token));
  } finally {
    await browser?.close().catch(() => {});
    await session?.reap(REAP_MS);
    rmSync(root, { recursive: true, force: true });
    inFlight.delete(abandon);
  }
  result.ok = result.problems.length === 0;
  return result;
}

// ------------------------------------------------------------------- the program

/** The commit and time the walked tree was built at, from its provenance; nothing when it cannot be read. */
function builtFrom(pluginDir) {
  try {
    const { commit, builtAt } = JSON.parse(readFileSync(path.join(pluginDir, 'PROVENANCE.json'), 'utf8'));
    return { commit, builtAt };
  } catch {
    return {};
  }
}

/**
 * @param {readonly string[]} argv
 * @param {{ pluginDir?: string, walkLeg?: typeof walkLeg, out?(line: string): void, err?(line: string): void, now?(): Date }} [deps]
 *   the tree to walk, the leg runner and the two streams — the tests' seams; the defaults are the real ones
 * @returns {Promise<number>} the exit code: 0 every leg passed, 1 a leg had a problem or the tree is not built, 2 usage
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  const args = parseArgs(argv);
  if ('help' in args) {
    out(USAGE);
    return 0;
  }
  if ('error' in args) {
    err(`walk-desktop-host: ${args.error}\n${USAGE}`);
    return 2;
  }
  const pluginDir = deps.pluginDir ?? PLUGIN_OUT_DIR;
  const launcher = path.join(pluginDir, PLUGIN.name, LAUNCHER_PATH);
  if (!existsSync(launcher)) {
    err(`walk-desktop-host: CANNOT RUN — ${launcher} is missing. This walk builds nothing; build the plugin first:\n  ${BUILD_COMMAND}`);
    return 1;
  }

  const say = (line) => err(`walk-desktop-host: ${line}`);
  if (args.legs.includes('brain')) say('leg 1 makes real calls on your own subscription — the brain’s readiness check and one Chess move. (--no-brain runs only the leg that spends nothing.)');
  const legs = [];
  for (const leg of args.legs) {
    try {
      legs.push(await (deps.walkLeg ?? walkLeg)(leg, { launcher, say }));
    } catch (error) {
      legs.push({ leg, ok: false, problems: [error instanceof Error ? error.message : String(error)], ms: {} });
    }
  }

  const dir = inside(pluginDir, REPO) ? path.relative(REPO, pluginDir) : pluginDir;
  const report = { walk: 'desktop-host', at: (deps.now ?? (() => new Date()))().toISOString(), plugin: { dir, ...builtFrom(pluginDir) }, ok: legs.every((leg) => leg.ok), legs };
  const { json, summary } = formatReport(report);
  out(summary);
  out(json);
  return report.ok ? 0 : 1;
}

/** Compared by REAL path: a script reached through a link (macOS's /var → /private/var) is still this one. */
const realPathOf = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

if (process.argv[1] !== undefined && realPathOf(process.argv[1]) === realPathOf(fileURLToPath(import.meta.url))) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      for (const abandon of inFlight) abandon();
      process.exit(130);
    });
  }
  process.exit(await main(process.argv.slice(2)));
}

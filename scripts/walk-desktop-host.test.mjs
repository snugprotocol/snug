// The desktop-host walk's own tests (TASK-20261003 D5).
//
// The walk itself is never run here: it starts the SHIPPED process under the user's real
// home and spends their subscription. What is tested is everything that decides whether it
// is SAFE to run and whether its report can be believed — the arguments, the environment it
// builds, the "is this runner mine" check and the abort that follows it (against a fake
// launcher, as the gate's legs are tested), the Chess bundle it hands in, and the report.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseBundleText } from './snug-embed.mjs';
import {
  BUILD_COMMAND,
  chessBundle,
  formatReport,
  GUI_PATH,
  judge,
  launchTarget,
  main,
  namesRemedy,
  parseArgs,
  readChess,
  scrubBearer,
  startOwnRunner,
  USAGE,
  WALK_LINEAGE,
  walkEnv,
  whyNotMine,
} from './walk-desktop-host.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WALK_SOURCE = readFileSync(path.join(REPO, 'scripts/walk-desktop-host.mjs'), 'utf8');
const TOKEN = 'c0ffee'.repeat(10) + 'beef'; // 64 hex digits, as the runner mints

describe('the arguments', () => {
  it('with none, both legs run — the real brain first, then no brain', () => {
    assert.deepEqual(parseArgs([]), { legs: ['brain', 'no-brain'] });
  });

  it('--no-brain runs ONLY the leg that spends nothing', () => {
    assert.deepEqual(parseArgs(['--no-brain']), { legs: ['no-brain'] });
    assert.deepEqual(parseArgs(['--no-brain', '--no-brain']), { legs: ['no-brain'] });
  });

  it('--help is help, wherever it stands', () => {
    assert.deepEqual(parseArgs(['--help']), { help: true });
    assert.deepEqual(parseArgs(['--no-brain', '-h']), { help: true });
  });

  for (const stray of ['--brain', '--no-brian', 'stop', '--home=/tmp/x', '']) {
    it(`anything else is an error that names it, and starts nothing: ${JSON.stringify(stray)}`, () => {
      // A typo must never fall through to "both legs": that is the one that spends.
      assert.deepEqual(parseArgs([stray]), { error: `unknown argument: ${JSON.stringify(stray)}` });
      assert.deepEqual(parseArgs(['--no-brain', stray]), { error: `unknown argument: ${JSON.stringify(stray)}` });
    });
  }

  it('the usage says what it costs', () => {
    assert.match(USAGE, /node scripts\/walk-desktop-host\.mjs \[--no-brain\]/);
    assert.match(USAGE, /your own subscription/);
  });
});

describe('the environment the launcher is started with — a desktop app’s, never this shell’s', () => {
  const inputs = { home: '/Users/someone', user: 'someone', tmp: '/var/folders/x/T', snugHome: '/var/folders/x/T/snug-walk-abc/snug' };

  it('is exactly five variables: the home, the user, the temp dir, the system PATH, and the walk’s own SNUG_HOME', () => {
    assert.deepEqual(walkEnv(inputs), {
      HOME: '/Users/someone',
      USER: 'someone',
      TMPDIR: '/var/folders/x/T',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SNUG_HOME: '/var/folders/x/T/snug-walk-abc/snug',
    });
    // What a process spawned by a desktop app gets (measured 2026-09-13: `launchctl getenv
    // PATH` is empty; the system default is this) — no nvm, no Homebrew, no shell profile.
    assert.equal(GUI_PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('takes NOTHING from this process’s environment — no key, no token, no PATH of ours (C1)', () => {
    const before = { ...process.env };
    const canaries = { ANTHROPIC_API_KEY: 'sk-ant-canary', OPENAI_API_KEY: 'sk-canary', CODEX_API_KEY: 'cx-canary', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-canary', SNUG_LIVE_BRAIN: 'claude', NODE_OPTIONS: '--inspect' };
    Object.assign(process.env, canaries);
    try {
      const env = walkEnv(inputs);
      assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'SNUG_HOME', 'TMPDIR', 'USER']);
      for (const value of Object.values(env)) for (const canary of Object.values(canaries)) assert.ok(!value.includes(canary));
      // Not this shell's PATH either: finding Node with no user PATH is what leg 1 proves.
      assert.equal(env.PATH, GUI_PATH);
    } finally {
      for (const name of Object.keys(canaries)) {
        if (name in before) process.env[name] = before[name];
        else delete process.env[name];
      }
    }
  });

  it('with a Node-only directory (leg 2), puts it FIRST on the PATH and changes nothing else', () => {
    // An empty HOME hides the CLI's login and every install root under it — and, on a
    // machine whose Node is an nvm install, Node itself. The leg gives the launcher a
    // directory holding `node` and nothing else, so the process starts and no CLI resolves.
    const env = walkEnv({ ...inputs, home: '/var/folders/x/T/snug-walk-abc/home', nodeDir: '/var/folders/x/T/snug-walk-abc/node' });
    assert.equal(env.PATH, '/var/folders/x/T/snug-walk-abc/node:/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(env.HOME, '/var/folders/x/T/snug-walk-abc/home');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'SNUG_HOME', 'TMPDIR', 'USER']);
  });

  for (const [what, snugHome] of [
    ['the user’s real ~/Snug', '/Users/someone/Snug'],
    ['a folder inside it', '/Users/someone/Snug/host'],
    ['the same folder, spelled with a trailing slash', '/Users/someone/Snug/'],
    ['the same folder, reached through ..', '/Users/someone/tmp/../Snug'],
    ['a relative path', 'snug-walk/snug'],
    ['nothing', ''],
  ]) {
    it(`REFUSES to build an environment whose SNUG_HOME is ${what}`, () => {
      // The release bundle is the one build allowed to resolve the real home (D-B34), and
      // SNUG_HOME is all that stands between it and the user's file (lesson 2026-09-07).
      assert.throws(() => walkEnv({ ...inputs, snugHome }), /SNUG_HOME/);
    });
  }

  it('accepts a temp home that merely shares a prefix with ~/Snug', () => {
    assert.equal(walkEnv({ ...inputs, snugHome: '/Users/someone/Snug-walk-tmp/snug' }).SNUG_HOME, '/Users/someone/Snug-walk-tmp/snug');
  });
});

describe('is this status MINE — the first thing believed about a started runner', () => {
  const own = { snugHome: '/tmp/snug-walk-abc/snug', pid: 4242 };
  const mine = { running: true, pid: 4242, home: '/tmp/snug-walk-abc/snug', file: '/tmp/snug-walk-abc/snug/user.snug', port: 51234 };

  it('a status from the child the walk started, on the home the walk made, is mine', () => {
    assert.deepEqual(whyNotMine(mine, own), []);
  });

  for (const [what, status, names] of [
    ['a home that is the user’s real one', { ...mine, home: '/Users/someone/Snug' }, /home.*\/Users\/someone\/Snug/],
    ['a home that only shares the temp dir’s prefix', { ...mine, home: '/tmp/snug-walk-abc/snug-other' }, /home/],
    ['a home ABOVE the walk’s', { ...mine, home: '/tmp/snug-walk-abc' }, /home/],
    ['a file outside the home — a home in the right place is not enough', { ...mine, file: '/Users/someone/Snug/user.snug' }, /file.*\/Users\/someone\/Snug\/user\.snug/],
    ['a file that climbs out with ..', { ...mine, file: '/tmp/snug-walk-abc/snug/../../real/user.snug' }, /file/],
    ['a file that IS the home', { ...mine, file: '/tmp/snug-walk-abc/snug' }, /file/],
    ['another process’s pid', { ...mine, pid: 4243 }, /pid 4243.*4242/],
    ['no pid at all', { ...mine, pid: undefined }, /pid/],
    ['a pid as a string', { ...mine, pid: '4242' }, /pid/],
    ['an ATTACHED session — the walk joined a runner it did not start', { ...mine, attached: true }, /attached/],
    ['no home', { ...mine, home: undefined }, /home/],
    ['no file', { ...mine, file: undefined }, /file/],
  ]) {
    it(`is NOT mine: ${what}`, () => {
      const problems = whyNotMine(status, own);
      assert.ok(problems.length > 0 && problems.some((p) => names.test(p)), JSON.stringify(problems));
    });
  }

  it('a runner that refused is not mine either, and its refusal is said in its own words', () => {
    const refused = { running: false, pid: 4242, refusal: { code: 'socket-path-too-long', message: 'the path is too long', remedy: 'set a shorter one' } };
    assert.deepEqual(whyNotMine(refused, own), ['the runner is not running — socket-path-too-long: the path is too long (set a shorter one)']);
    assert.deepEqual(whyNotMine({ running: false }, own), ['the runner is not running']);
  });

  it('never throws on an answer that is not a status', () => {
    for (const junk of [undefined, null, 'ok', 7, []]) assert.ok(whyNotMine(junk, own).length > 0);
  });
});

describe('the launch address the walk will open', () => {
  it('is its own runner’s loopback address, with the bearer taken out of it', () => {
    assert.deepEqual(launchTarget(`http://127.0.0.1:51234/#token=${TOKEN}`, 51234), { url: `http://127.0.0.1:51234/#token=${TOKEN}`, origin: 'http://127.0.0.1:51234', token: TOKEN });
  });

  for (const [what, url] of [
    ['another port', `http://127.0.0.1:43127/#token=${TOKEN}`],
    ['localhost', `http://localhost:51234/#token=${TOKEN}`],
    ['another host that starts the same', `http://127.0.0.1.evil.test:51234/#token=${TOKEN}`],
    ['https', `https://127.0.0.1:51234/#token=${TOKEN}`],
    ['a path', `http://127.0.0.1:51234/somewhere#token=${TOKEN}`],
    ['no token (an attached session’s address)', 'http://127.0.0.1:51234/'],
    ['a short token', 'http://127.0.0.1:51234/#token=abc'],
    ['not a URL', 'open it yourself'],
  ]) {
    it(`refuses ${what} — and the refusal never repeats the token`, () => {
      assert.throws(
        () => launchTarget(url, 51234),
        (error) => /launch address/.test(error.message) && !error.message.includes(TOKEN),
      );
    });
  }
});

describe('the Chess app the walk hands in', () => {
  it('is examples/chess, whole: its html, its runtime contract, no connection', () => {
    const chess = readChess();
    const bundle = chessBundle({ ...chess, sharedAt: '2026-10-03T00:00:00.000Z' });
    assert.equal(bundle.html, readFileSync(path.join(REPO, 'examples/chess/app.html'), 'utf8'));
    assert.deepEqual(bundle.contract, JSON.parse(readFileSync(path.join(REPO, 'examples/chess/runtime-contract.json'), 'utf8')));
    assert.deepEqual(bundle.connections, []);
    assert.equal(bundle.app.displayName, 'Chess');
    assert.equal(bundle.lineage, WALK_LINEAGE);
    assert.deepEqual(Object.keys(bundle).sort(), ['app', 'connections', 'contract', 'format', 'html', 'lineage', 'sharedAt']);
  });

  it('passes the skill’s own boundary parse, and the protocol’s', async () => {
    const text = JSON.stringify(chessBundle({ ...readChess(), sharedAt: '2026-10-03T00:00:00.000Z' }));
    const lenient = parseBundleText(text);
    assert.equal(lenient.ok, true, lenient.error);
    // The parser the runner applies to a hand-in (`parseAppBundle`), from the protocol's
    // BUILT output: a bundle only the walk believes in would be refused at leg 1's third step.
    const built = path.join(REPO, 'packages/protocol/dist/app-bundle.js');
    assert.ok(existsSync(built), `${path.relative(REPO, built)} is missing — pnpm --filter @snugprotocol/protocol build`);
    const { parseAppBundle } = await import(pathToFileURL(built).href);
    const strict = parseAppBundle(text);
    assert.equal(strict.ok, true, JSON.stringify(strict));
    // "A small bundled app": far inside the stdio line cap and the bundle cap.
    assert.ok(Buffer.byteLength(text) < 64 * 1024, `${Buffer.byteLength(text)} bytes`);
  });
});

describe('does the chip name a remedy (leg 2)', () => {
  it('accepts the sentences a not-ready brain is given', () => {
    for (const text of [
      'No `claude` CLI found on this machine — Snug is using its demo brain. Install Claude Code (https://code.claude.com/docs/en/quickstart), then run `claude` and `/login`, and check again.',
      'demo brain — no Claude CLI found; install Claude Code (code.claude.com), then run `claude` and `/login`',
      'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.',
      'Your Claude CLI is out of date — run `claude update`, then check again.',
    ]) {
      assert.equal(namesRemedy(text), true, text);
    }
  });

  it('refuses a chip that only says what is wrong, or nothing', () => {
    for (const text of ['demo brain', 'demo brain — nothing to configure', 'Claude · not ready', '', undefined]) assert.equal(namesRemedy(text), false, String(text));
  });
});

describe('the verdict — what a leg’s observations amount to', () => {
  // The walk records and `judge` decides, apart: a walk that cannot be shown to FAIL vouches
  // for nothing, and none of these failures can be staged with a real brain.
  const brain = {
    ready: true,
    active: 'claude',
    moved: true,
    handIn: 'installed "Chess" in the open runner',
    reply: { ms: 6201 },
    chip: { text: 'Claude · Sonnet 5', brain: 'host' },
    saidDemo: false,
    chat: [{ status: 200, brain: 'claude' }],
    pageErrors: [],
  };
  const noBrain = {
    ready: false,
    active: null,
    moved: true,
    handIn: 'installed "Chess" in the open runner',
    reply: { ms: 310 },
    chip: { text: 'demo brain', brain: 'demo' },
    saidDemo: true,
    remedy: 'what’s thinking demo brain — no Claude CLI found; install Claude Code (code.claude.com), then run `claude` and `/login`',
    chat: [],
    pageErrors: [],
  };

  it('leg 1 passes: a brain was ready, Chess was installed, the move was answered by a think the runner says a brain took', () => {
    assert.deepEqual(judge('brain', brain), []);
  });

  for (const [what, change, names] of [
    ['no brain became ready', { ready: false }, /^no brain became ready within 60 s of the page opening$/],
    ['the hand-in was sent but not confirmed', { handIn: 'sent "Chess" to the open runner — not confirmed' }, /^snug_hand_in did not install Chess: sent "Chess" to the open runner — not confirmed$/],
    ['the hand-in was refused', { handIn: 'refused: the file could not be opened' }, /^snug_hand_in did not install Chess: refused: the file could not be opened$/],
    ['the hand-in answered nothing', { handIn: undefined }, /^snug_hand_in did not install Chess/],
    ['the move went unanswered', { reply: undefined }, /^the move was not answered within 120 s$/],
    ['the think failed in the app', { reply: { failed: 'the agent went quiet (HTTP 502). poke it to retry.' } }, /^the think failed — the app says: the agent went quiet \(HTTP 502\)/],
    ['the page said demo', { saidDemo: true, chip: { text: 'demo brain', brain: 'demo' } }, /^the page said demo — the real brain did not answer \(the chip says “demo brain”\)$/],
    ['the move was answered but nothing reached the runner’s brain', { chat: [] }, /^the move was answered, but no think reached the runner’s brain$/],
    ['the answer names no brain', { chat: [{ status: 200, brain: null }] }, /no x-snug-brain header/],
    ['the runner answered 502', { chat: [{ status: 502, brain: null }, { status: 200, brain: 'claude' }] }, /^the runner answered a think with HTTP 502$/],
    ['the runner answered 503', { chat: [{ status: 200, brain: 'claude' }, { status: 503, brain: null }] }, /^the runner answered a think with HTTP 503$/],
    ['the page threw', { pageErrors: ['boom'] }, /^the page threw: boom$/],
  ]) {
    it(`leg 1 FAILS when ${what}`, () => {
      const problems = judge('brain', { ...brain, ...change });
      assert.ok(problems.some((problem) => names.test(problem)), JSON.stringify(problems));
    });
  }

  it('leg 1: each failure is its own problem — nothing else is invented beside it', () => {
    assert.deepEqual(judge('brain', { ...brain, pageErrors: ['boom'] }), ['the page threw: boom']);
    assert.deepEqual(judge('brain', { ...brain, ready: false }), ['no brain became ready within 60 s of the page opening']);
  });

  it('leg 2 passes: the page says demo, the chip names the remedy, the demo brain answered, and nothing was sent', () => {
    assert.deepEqual(judge('no-brain', noBrain), []);
    // Never having had a ready brain is this leg's premise, not its problem.
    assert.equal(noBrain.ready, false);
  });

  for (const [what, change, names] of [
    ['the page did not say demo', { saidDemo: false, chip: { text: 'Claude · your CLI', brain: 'host' } }, /^the page did not say demo \(the chip says “Claude · your CLI”\)$/],
    ['the chip names no remedy', { remedy: 'what’s thinking demo brain' }, /^the chip does not name a remedy — it says: “what’s thinking demo brain”$/],
    ['the chip’s menu was never read', { remedy: undefined }, /^the chip does not name a remedy/],
    ['a think was answered 502', { chat: [{ status: 502, brain: null }] }, /^a think was answered 502 — with no brain ready the demo brain must answer$/],
    ['the hand-in was refused', { handIn: 'refused: the file could not be opened' }, /^snug_hand_in did not install Chess: refused/],
    ['the move went unanswered', { reply: undefined }, /^the move was not answered within 120 s$/],
    ['the think failed in the app', { reply: { failed: 'the agent went quiet (no brain). poke it to retry.' } }, /^the think failed — the app says: the agent went quiet/],
    ['the page threw', { pageErrors: ['boom'] }, /^the page threw: boom$/],
  ]) {
    it(`leg 2 FAILS when ${what}`, () => {
      const problems = judge('no-brain', { ...noBrain, ...change });
      assert.ok(problems.some((problem) => names.test(problem)), JSON.stringify(problems));
    });
  }

  it('leg 2 with a brain that was NOT hidden: one problem, which says no move was made — and nothing about a hand-in or a reply that never happened', () => {
    const seen = { ...noBrain, active: 'claude', moved: false, handIn: undefined, reply: undefined, chip: { text: 'Claude · Sonnet 5', brain: 'host' }, saidDemo: false };
    const problems = judge('no-brain', seen);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /^the brain was NOT hidden \(auto → claude, the chip says “Claude · Sonnet 5”\), so no move was made\./);
    assert.match(problems[0], /\/opt\/homebrew\/bin/);
  });

  it('leg 2: a think the runner declined (503) and the page then answered with its demo brain is recorded, not failed — the 502 is the failure', () => {
    assert.deepEqual(judge('no-brain', { ...noBrain, chat: [{ status: 503, brain: null }] }), []);
  });
});

describe('the bearer never reaches the report', () => {
  it('is scrubbed from any text, by value and by shape', () => {
    assert.equal(scrubBearer(`page.goto: timeout navigating to "http://127.0.0.1:51234/#token=${TOKEN}"`, TOKEN), 'page.goto: timeout navigating to "http://127.0.0.1:51234/#token=[bearer]"');
    assert.equal(scrubBearer(`authorization: Bearer ${TOKEN} was refused`, TOKEN), 'authorization: Bearer [bearer] was refused');
    // With no token known yet, the address's shape is enough.
    assert.equal(scrubBearer(`http://127.0.0.1:1/#token=${TOKEN}`, undefined), 'http://127.0.0.1:1/#token=[bearer]');
    assert.equal(scrubBearer('nothing to hide', TOKEN), 'nothing to hide');
  });
});

describe('the report', () => {
  const report = {
    walk: 'desktop-host',
    at: '2026-10-03T21:00:00.000Z',
    plugin: { dir: 'dist/plugin', commit: 'abc1234-dirty', builtAt: '2026-10-03T20:55:00.000Z' },
    ok: false,
    legs: [
      {
        leg: 'brain',
        ok: true,
        problems: [],
        runner: { version: '0.1.0', build: '1a2b3c4', platform: 'darwin', pid: 4242, port: 51234 },
        ms: { initialize: 412, status: 3, brainReady: 4812, think: 6201 },
        handIn: 'installed "Chess" in the open runner',
        active: 'claude',
        brains: [{ id: 'claude', state: 'ready', verified: true }, { id: 'codex', state: 'absent', verified: false }],
        chip: { text: 'Claude · Sonnet 5', brain: 'host' },
        answered: { header: 'claude', by: 'claude-sonnet-5-20260101' },
        chat: [{ status: 200, brain: 'claude' }],
        saidDemo: false,
        offScript: false,
      },
      {
        leg: 'no-brain',
        ok: false,
        problems: ['the chip does not name a remedy — it says: “demo brain”'],
        runner: { version: '0.1.0', build: '1a2b3c4', platform: 'darwin', pid: 4250, port: 51240 },
        ms: { initialize: 380, status: 2, think: 310 },
        handIn: 'installed "Chess" in the open runner',
        active: null,
        brains: [{ id: 'claude', state: 'absent', verified: true }],
        chip: { text: 'demo brain', brain: 'demo' },
        remedy: 'demo brain',
        answered: { header: null, by: null },
        chat: [],
        saidDemo: true,
        offScript: true,
      },
    ],
  };

  it('is ONE line of JSON that reads back as the report', () => {
    const { json } = formatReport(report);
    assert.ok(!json.includes('\n'));
    assert.deepEqual(JSON.parse(json), report);
  });

  it('is a summary a person can paste into the journal: every number, what answered, whether the page said demo', () => {
    const { summary } = formatReport(report);
    assert.equal(
      summary,
      [
        'desktop-host walk · dist/plugin (commit abc1234-dirty, built 2026-10-03T20:55:00.000Z) · 2026-10-03T21:00:00.000Z · FAIL',
        '',
        'leg 1 · the real brain — PASS',
        '  runner   Snug 0.1.0 (build 1a2b3c4, darwin) pid 4242, port 51234 · initialize 412 ms · snug_status 3 ms',
        '  hand-in  installed "Chess" in the open runner',
        '  brains   claude ready · codex absent (unverified) · auto → claude · ready after 4,812 ms',
        '  think    answered in 6,201 ms · x-snug-brain: claude · answered by: claude-sonnet-5-20260101',
        '  page     chip “Claude · Sonnet 5” · said demo: no · off-script reply: no · thinks sent to the runner: 200',
        '',
        'leg 2 · no brain — FAIL',
        '  runner   Snug 0.1.0 (build 1a2b3c4, darwin) pid 4250, port 51240 · initialize 380 ms · snug_status 2 ms',
        '  hand-in  installed "Chess" in the open runner',
        '  brains   claude absent · auto → none',
        '  think    answered in 310 ms · x-snug-brain: none · answered by: —',
        '  page     chip “demo brain” · said demo: yes · off-script reply: yes · thinks sent to the runner: none',
        '  remedy   “demo brain”',
        '  ! the chip does not name a remedy — it says: “demo brain”',
      ].join('\n'),
    );
  });

  it('says what is missing rather than inventing it — a leg that aborted before it measured anything', () => {
    const aborted = { ...report, legs: [{ leg: 'brain', ok: false, problems: ['ISOLATION — the status names home "/Users/someone/Snug"'], ms: {} }] };
    const { summary } = formatReport(aborted);
    assert.match(summary, /leg 1 · the real brain — FAIL\n {2}! ISOLATION — the status names home "\/Users\/someone\/Snug"$/);
    assert.doesNotMatch(summary, /undefined|NaN/);
  });

  it('never prints the bearer, whatever a leg put in its problems (C1)', () => {
    const leaky = { ...report, legs: [{ leg: 'brain', ok: false, problems: [`could not open http://127.0.0.1:51234/#token=${TOKEN}`], ms: {} }] };
    const { json, summary } = formatReport(leaky);
    assert.ok(!json.includes(TOKEN) && !summary.includes(TOKEN));
    assert.match(summary, /#token=\[bearer\]/);
  });
});

describe('starting the shipped launcher and establishing it is the walk’s OWN (against a fake launcher)', () => {
  const outlived = [];
  afterEach(() => {
    assert.deepEqual(outlived.splice(0), [], 'the walk left a process running');
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * A launcher whose process answers MCP on stdio and the control socket under its
   * SNUG_HOME, as `mode` says. Every start and every control op it is asked is logged.
   */
  const fake = (mode) => {
    // A short prefix: the control socket lives under this, and `sun_path` is 104 bytes.
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-wt-'));
    const starts = path.join(dir, 'starts.log');
    const ops = path.join(dir, 'ops.log');
    const script = path.join(dir, 'fake-runner.mjs');
    writeFileSync(
      script,
      `import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
const home = process.env.SNUG_HOME;
const PORT = 51234;
mkdirSync(path.join(home, 'host'), { recursive: true });
createServer((socket) => {
  createInterface({ input: socket }).on('line', (line) => {
    const { op } = JSON.parse(line);
    appendFileSync(${JSON.stringify(ops)}, op + '\\n');
    const who = { tokenHash: 'hash', port: PORT, version: '0.1.0', build: 'fake', platform: process.platform, pid: mode === 'socket-wrong-pid' ? process.pid + 1 : process.pid };
    const launch = mode === 'foreign-url' ? 'http://evil.test:' + PORT + '/#token=${TOKEN}' : 'http://127.0.0.1:' + PORT + '/#token=${TOKEN}';
    const answer =
      op === 'hello' ? (mode === 'older-build' ? who : { ...who, ok: true, op })
      : op === 'launch-url' ? (mode === 'older-build' ? who : mode === 'unacked-launch' ? { url: launch, op } : { url: launch, ok: true, op })
      : { error: 'unknown op' };
    socket.write(JSON.stringify(answer) + '\\n');
  });
}).listen(path.join(home, 'host', 'ctl.sock'));
const base = { running: true, version: '0.1.0', build: 'fake', platform: process.platform, pid: process.pid, home, file: path.join(home, 'user.snug'), port: PORT, pages: 0, clients: 0, binding: 'local-host' };
const status = () =>
  mode === 'leaks-home' ? { ...base, home: '/Users/someone/Snug' }
  : mode === 'leaks-file' ? { ...base, file: '/Users/someone/Snug/user.snug' }
  : mode === 'wrong-pid' ? { ...base, pid: process.pid + 1 }
  : mode === 'attached' ? { ...base, attached: true, pid: process.pid + 1 }
  : mode === 'refused' ? { running: false, pid: process.pid, refusal: { code: 'listen-failed', message: 'could not listen', remedy: 'try again' } }
  : base;
if (mode === 'lingers') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000); }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || mode === 'silent') return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snug', version: '0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: (mode === 'no-hand-in' ? ['snug_status', 'snug_open'] : ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps']).map((name) => ({ name })) });
  else reply(message.id, { content: [{ type: 'text', text: JSON.stringify(status()) }] });
});
process.stdin.on('end', () => { if (mode !== 'lingers') process.exit(0); });
`,
    );
    const launcher = path.join(dir, 'snug');
    writeFileSync(launcher, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []);
    const snugHome = path.join(dir, 'snug-home');
    return {
      launcher,
      snugHome,
      // The test's own choice of PATH: the fake launcher needs a `node`, the real one finds its own.
      env: { HOME: path.join(dir, 'home'), SNUG_HOME: snugHome, PATH: path.dirname(process.execPath) },
      pids: () => lines(starts).map(Number),
      ops: () => lines(ops),
      remove: () => {
        // Whatever this launcher started and the walk did not reap is reported — and ended
        // here (they are this fixture's own processes), so the failure is the assertion in
        // `afterEach` and never a suite that hangs on a child nobody is waiting for.
        const left = lines(starts).map(Number).filter(alive);
        outlived.push(...left);
        for (const pid of left) process.kill(pid, 'SIGKILL');
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };
  const quick = { requestTimeoutMs: 1_500, reapMs: 1_000 };
  const start = (f) => startOwnRunner({ launcher: f.launcher, env: f.env, ...quick });
  /**
   * The error a start is refused with. A start that wrongly SUCCEEDS is reaped here and
   * fails by name: left to `assert.rejects`, its runner would stay up and the suite would
   * hang on it instead of going red.
   */
  const refusal = async (starting) => {
    let own;
    try {
      own = await starting;
    } catch (error) {
      return error;
    }
    await own.session.reap(quick.reapMs);
    assert.fail('the start was not refused — the walk went on with a runner it should have stopped at');
  };

  it('an honest runner: the handshake is timed, the status is the walk’s own, and the launch address comes from ITS socket', async () => {
    const f = fake('honest');
    try {
      const own = await start(f);
      try {
        assert.equal(own.status.pid, own.session.child.pid);
        assert.equal(own.status.home, f.snugHome);
        assert.deepEqual(own.target, { url: `http://127.0.0.1:51234/#token=${TOKEN}`, origin: 'http://127.0.0.1:51234', token: TOKEN });
        assert.ok(Number.isInteger(own.ms.initialize) && own.ms.initialize >= 0);
        assert.ok(Number.isInteger(own.ms.status) && own.ms.status >= 0);
        // Asked in this order, and nothing else: who are you, then the address.
        assert.deepEqual(f.ops(), ['hello', 'launch-url']);
        assert.equal(alive(own.session.child.pid), true, 'the runner is left running for the caller, which reaps it');
      } finally {
        await own.session.reap(quick.reapMs);
      }
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  for (const [mode, names] of [
    ['leaks-home', /\/Users\/someone\/Snug/],
    ['leaks-file', /\/Users\/someone\/Snug\/user\.snug/],
    ['wrong-pid', /pid/],
    ['attached', /attached/],
    ['refused', /listen-failed: could not listen \(try again\)/],
  ]) {
    it(`ABORTS before touching anything else when the status is not its own (${mode}) — no control socket is spoken to, and its child is reaped`, async () => {
      const f = fake(mode);
      try {
        const { message } = await refusal(start(f));
        assert.match(message, /ISOLATION/);
        assert.match(message, names);
        assert.deepEqual(f.ops(), [], 'the walk asked a control socket something after a status that was not its own');
        assert.equal(f.pids().length, 1);
        assert.equal(alive(f.pids()[0]), false, 'the child the walk started was left running');
      } finally {
        f.remove();
      }
    });
  }

  it('ABORTS when the control socket under its home is answered by another pid — the address is never asked for', async () => {
    const f = fake('socket-wrong-pid');
    try {
      assert.match((await refusal(start(f))).message, /ISOLATION.*control socket/);
      assert.deepEqual(f.ops(), ['hello']);
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  it('ABORTS on a runner that does not ack — an older build answers every op with its hello', async () => {
    const f = fake('older-build');
    try {
      assert.match((await refusal(start(f))).message, /control socket/);
      assert.deepEqual(f.ops(), ['hello']);
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  it('takes a launch address only from an answer that ACKS the op — an address with no ack is not believed (L3)', async () => {
    const f = fake('unacked-launch');
    try {
      const { message } = await refusal(start(f));
      assert.match(message, /did not acknowledge the launch address request/);
      assert.ok(!message.includes(TOKEN));
      assert.deepEqual(f.ops(), ['hello', 'launch-url']);
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  it('refuses a launch address that is not its own runner’s — and the error does not carry the token', async () => {
    const f = fake('foreign-url');
    try {
      const { message } = await refusal(start(f));
      assert.match(message, /launch address/);
      assert.ok(!message.includes(TOKEN));
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  it('names a runner that cannot take a hand-in, before a browser is ever opened', async () => {
    const f = fake('no-hand-in');
    try {
      assert.match((await refusal(start(f))).message, /tools\/list.*snug_hand_in/);
      assert.deepEqual(f.ops(), []);
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  it('a launcher that never answers is named, does not hang, and is reaped', async () => {
    const f = fake('silent');
    try {
      const began = Date.now();
      assert.match((await refusal(start(f))).message, /initialize was not answered/);
      assert.ok(Date.now() - began < 10_000);
      assert.equal(alive(f.pids()[0]), false);
    } finally {
      f.remove();
    }
  });

  it('REFUSES to start anything with an environment that has no SNUG_HOME', async () => {
    const f = fake('honest');
    try {
      assert.match((await refusal(startOwnRunner({ launcher: f.launcher, env: { HOME: '/Users/someone', PATH: f.env.PATH }, ...quick }))).message, /SNUG_HOME/);
      assert.deepEqual(f.pids(), [], 'a process was started with no home of its own');
    } finally {
      f.remove();
    }
  });
});

describe('the program', () => {
  const io = () => {
    const out = [];
    const err = [];
    return { out, err, deps: { out: (line) => out.push(line), err: (line) => err.push(line), now: () => new Date('2026-10-03T21:00:00.000Z') } };
  };
  /** A folder that looks like a built plugin: the launcher exists. Nothing in it is ever run. */
  const builtPlugin = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-wt-plugin-'));
    mkdirSync(path.join(dir, 'snug/scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'snug/scripts/snug'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(path.join(dir, 'PROVENANCE.json'), JSON.stringify({ commit: 'abc1234', builtAt: '2026-10-03T20:55:00.000Z', files: {} }));
    return dir;
  };
  const passing = (calls) => async (leg, context) => {
    calls.push([leg, context.launcher]);
    return { leg, ok: true, problems: [], ms: {} };
  };

  it('--help prints the usage and starts nothing', async () => {
    const { out, err, deps } = io();
    const calls = [];
    assert.equal(await main(['--help'], { ...deps, walkLeg: passing(calls) }), 0);
    assert.deepEqual(out, [USAGE]);
    assert.deepEqual(err, []);
    assert.deepEqual(calls, []);
  });

  it('an unknown argument is exit 2 with the usage — and starts nothing', async () => {
    const { out, err, deps } = io();
    const calls = [];
    assert.equal(await main(['--no-brian'], { ...deps, walkLeg: passing(calls) }), 2);
    assert.deepEqual(out, []);
    assert.match(err.join('\n'), /unknown argument: "--no-brian"/);
    assert.ok(err.join('\n').includes(USAGE));
    assert.deepEqual(calls, []);
  });

  it('with no built plugin it CANNOT RUN: it prints the build command, builds nothing, starts nothing', async () => {
    const { out, err, deps } = io();
    const calls = [];
    const nowhere = path.join(tmpdir(), 'snug-wt-no-such-plugin');
    assert.equal(await main([], { ...deps, pluginDir: nowhere, walkLeg: passing(calls) }), 1);
    assert.match(err.join('\n'), /CANNOT RUN — .*snug\/scripts\/snug is missing/);
    assert.ok(err.join('\n').includes(BUILD_COMMAND));
    assert.equal(BUILD_COMMAND, 'pnpm build && node scripts/build-plugin.mjs');
    assert.deepEqual(out, []);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(nowhere), false);
  });

  it('runs the legs it was asked for, in order, on the SHIPPED launcher — then prints the summary and the JSON line', async () => {
    const plugin = builtPlugin();
    try {
      const both = io();
      const calls = [];
      assert.equal(await main([], { ...both.deps, pluginDir: plugin, walkLeg: passing(calls) }), 0);
      assert.deepEqual(calls, [['brain', path.join(plugin, 'snug/scripts/snug')], ['no-brain', path.join(plugin, 'snug/scripts/snug')]]);
      assert.equal(both.out.length, 2);
      assert.match(both.out[0], /^desktop-host walk · .*\(commit abc1234, built 2026-10-03T20:55:00\.000Z\) · 2026-10-03T21:00:00\.000Z · PASS/);
      assert.deepEqual(JSON.parse(both.out[1]).legs.map((leg) => leg.leg), ['brain', 'no-brain']);
      assert.equal(JSON.parse(both.out[1]).ok, true);

      const free = io();
      const only = [];
      assert.equal(await main(['--no-brain'], { ...free.deps, pluginDir: plugin, walkLeg: passing(only) }), 0);
      assert.deepEqual(only.map(([leg]) => leg), ['no-brain']);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it('a leg with a problem is exit 1 — and the other leg still runs', async () => {
    const plugin = builtPlugin();
    const { out, deps } = io();
    const ran = [];
    const walkLeg = async (leg) => {
      ran.push(leg);
      return leg === 'brain' ? { leg, ok: false, problems: ['the page said demo'], ms: {} } : { leg, ok: true, problems: [], ms: {} };
    };
    try {
      assert.equal(await main([], { ...deps, pluginDir: plugin, walkLeg }), 1);
      assert.deepEqual(ran, ['brain', 'no-brain']);
      assert.equal(JSON.parse(out[1]).ok, false);
      assert.match(out[0], /· FAIL/);
      assert.match(out[0], /! the page said demo/);
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  it('a leg that THROWS is a failed leg with its reason — never a stack, never the bearer, and the next leg still runs', async () => {
    const plugin = builtPlugin();
    const { out, deps } = io();
    const ran = [];
    const walkLeg = async (leg) => {
      ran.push(leg);
      if (leg === 'brain') throw new Error(`could not open http://127.0.0.1:51234/#token=${TOKEN}`);
      return { leg, ok: true, problems: [], ms: {} };
    };
    try {
      assert.equal(await main([], { ...deps, pluginDir: plugin, walkLeg }), 1);
      assert.deepEqual(ran, ['brain', 'no-brain']);
      const report = JSON.parse(out[1]);
      assert.deepEqual(report.legs[0], { leg: 'brain', ok: false, problems: ['could not open http://127.0.0.1:51234/#token=[bearer]'], ms: {} });
      assert.ok(!out.join('\n').includes(TOKEN));
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });
});

describe('the walk is opt-in, and bounded to what it started (read from its own source and the gates)', () => {
  it('no gate runs it: the root scripts name only its TEST, and neither CI nor the local gate names it at all', () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts;
    for (const [name, command] of Object.entries(scripts)) {
      assert.ok(!command.replaceAll('walk-desktop-host.test.mjs', '').includes('walk-desktop-host'), `the root script "${name}" runs the walk — it spends the user's subscription and belongs in no gate`);
    }
    assert.ok(scripts['check-host-mcp'].includes('scripts/walk-desktop-host.test.mjs'), 'the walk’s own tests must run in the check-host-mcp list');
    const workflows = path.join(REPO, '.github/workflows');
    for (const file of [path.join(REPO, 'scripts/gate-local.mjs'), ...readdirSync(workflows).map((name) => path.join(workflows, name))]) {
      assert.ok(!readFileSync(file, 'utf8').includes('walk-desktop-host'), `${path.relative(REPO, file)} names the walk`);
    }
  });

  it('asks its runner’s control socket for two things only — who it is, and the launch address — and never `stop`', () => {
    const asked = [...WALK_SOURCE.matchAll(/\bop: '([a-z-]+)'/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(asked)].sort(), ['hello', 'launch-url']);
  });

  it('speaks to the socket where the process puts it, by the ops the process knows (text-pinned against apps/host-mcp)', () => {
    assert.match(WALK_SOURCE, /path\.join\(snugHome, 'host', 'ctl\.sock'\)/);
    assert.match(readFileSync(path.join(REPO, 'apps/host-mcp/src/lock.ts'), 'utf8'), /controlSocketPath = \(dir: string\): string => path\.join\(dir, 'ctl\.sock'\)/);
    assert.match(readFileSync(path.join(REPO, 'apps/host-mcp/src/cli.ts'), 'utf8'), /path\.join\(deps\.home\(\), 'host'\)/);
    const ops = /export const CONTROL_OPS = \[([^\]]+)\] as const;/.exec(readFileSync(path.join(REPO, 'apps/host-mcp/src/control-socket.ts'), 'utf8'))?.[1] ?? '';
    for (const op of ['hello', 'launch-url']) assert.ok(ops.includes(`'${op}'`), `the process no longer knows the control op ${op}`);
  });

  it('signals nothing by pid, opts into no live-brain hook, and builds nothing', () => {
    // Its one child is ended through the child's own handle (`reap`), which cannot name
    // another process; `process.kill(pid)` can.
    assert.doesNotMatch(WALK_SOURCE, /process\.kill\(/);
    assert.doesNotMatch(WALK_SOURCE, /SNUG_LIVE_BRAIN/);
    assert.doesNotMatch(WALK_SOURCE, /buildPlugin\(|execFileSync|execSync|spawnSync/);
  });

  it('loads Playwright from apps/host — the dependency that is already there — and adds none', () => {
    assert.match(WALK_SOURCE, /createRequire\(path\.join\(REPO, 'apps\/host\/package\.json'\)\)/);
    const host = JSON.parse(readFileSync(path.join(REPO, 'apps/host/package.json'), 'utf8'));
    assert.ok('@playwright/test' in host.devDependencies);
    const root = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.ok(!('@playwright/test' in { ...root.dependencies, ...root.devDependencies }), 'Playwright was added to the root for the walk');
  });
});

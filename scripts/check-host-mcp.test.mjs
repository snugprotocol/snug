// Tests for the local-host-process gate.
//
// Every rule gets a MUTANT: a gate that cannot be shown to fail is a gate vouching for
// nothing. `node --test`, named `*.test.mjs` to match the other root scripts (the
// `*.node-test.mjs` convention exists for packages where vitest would also collect them;
// scripts/ is vitest-run).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ARCHIVE_NAME, archiveEntries, buildPlugin, MAX_FILE_BYTES, PAGE_PATH, PAGE_PIN_PATH } from './build-plugin.mjs';
import { FAKE_SKILL, fixtures } from './build-plugin.test.mjs';
import {
  ALLOWED_ENV_READS,
  ALLOWED_WHOLE_ENV_READS,
  bundleSizeLine,
  checkArchive,
  checkBundle,
  checkInstructions,
  checkPluginTree,
  FORBIDDEN_PREFIX_IN_RELEASE,
  GATE_LEGS,
  INSTRUCTIONS_FILE,
  isolationEnv,
  REVIEWER_HOLD_BYTES,
  runDamagedPageLeg,
  runGate,
  runLaunchLegs,
  runValidators,
} from './check-host-mcp.mjs';
import { LAUNCHER_PATH } from './lib/plugin-manifests.mjs';
import { renderSkill, SKILL_SOURCE } from './lib/skill-build.mjs';
import { createZip } from './lib/zip.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const CLEAN = `const home = process.env.HOME; const t = process.env.TMPDIR; export const tools = ['snug_status'];`;

describe('the release-inertness sweep', () => {
  it('passes a bundle with no hook', () => {
    assert.deepEqual(checkBundle(CLEAN), []);
  });

  it('sweeps for the test hooks’ PREFIX, not a list of their names (K5)', () => {
    // A list is only ever as current as the last person to remember it: the test entry had
    // five hooks and the list named three. Every hook the test entry reads starts with this.
    assert.equal(FORBIDDEN_PREFIX_IN_RELEASE, 'SNUG_MCP_TEST_');
    const entry = readFileSync(new URL('../apps/host-mcp/src/main.test-hooks.ts', import.meta.url), 'utf8');
    const hooks = [...entry.matchAll(/'(SNUG_[A-Z0-9_]+)'/g)].map((match) => match[1]);
    assert.ok(hooks.length >= 5, `expected the test entry to name its hooks, found ${JSON.stringify(hooks)}`);
    for (const name of hooks) assert.ok(name.startsWith(FORBIDDEN_PREFIX_IN_RELEASE), `${name} is a test hook the prefix sweep would miss`);
  });

  // (`…_BRAINS` is the registry's fake-driver hook; the three single-brain names it replaced
  // stay in the list — a retired hook's name in the shipped bytes is still a hook that shipped.)
  for (const name of ['SNUG_MCP_TEST_RESOLVE', 'SNUG_MCP_TEST_HOLDER', 'SNUG_MCP_TEST_BRAINS', 'SNUG_MCP_TEST_BRAIN', 'SNUG_MCP_TEST_BRAIN_MODEL', 'SNUG_MCP_TEST_MODELS', 'SNUG_MCP_TEST_ENTRY', 'SNUG_MCP_TEST_A_HOOK_NOBODY_HAS_WRITTEN_YET']) {
    it(`catches ${name} in the shipped bytes`, () => {
      // The mutant: the test build's env name reaching the release artifact.
      const problems = checkBundle(`${CLEAN} process.env.${name};`);
      assert.ok(problems.some((p) => p.includes(name)), `expected ${name} to be caught, got ${JSON.stringify(problems)}`);
    });
  }

  it('catches a hook that is only a STRING in the bundle — the test entry reads its names through constants', () => {
    const problems = checkBundle(`${CLEAN} const HOOK = "SNUG_MCP_TEST_GRACE_MS"; process.env[HOOK];`);
    assert.ok(problems.some((p) => p.includes('SNUG_MCP_TEST_GRACE_MS')), JSON.stringify(problems));
  });

  it('catches an environment variable nobody declared', () => {
    const problems = checkBundle(`${CLEAN} process.env.ANTHROPIC_API_KEY;`);
    assert.ok(problems.some((p) => p.includes('ANTHROPIC_API_KEY')));
  });

  it('catches a lowercase or mixed-case name — the sweep is not uppercase-only', () => {
    assert.ok(checkBundle(`${CLEAN} process.env.snugDebug;`).some((p) => p.includes('snugDebug')));
  });

  it('catches the bracket spelling too', () => {
    const problems = checkBundle(`${CLEAN} process.env['SOME_DEBUG_FLAG'];`);
    assert.ok(problems.some((p) => p.includes('SOME_DEBUG_FLAG')));
  });

  it('admits every declared read', () => {
    const reads = ALLOWED_ENV_READS.map((name) => `process.env.${name}`).join(';');
    assert.deepEqual(checkBundle(`${CLEAN} ${reads}`), []);
  });

  it('catches an env read the name-sweep cannot see — a bare `process.env` handed to a function', () => {
    // THE GAP THIS CLOSES. The real bundle contains no `process.env.X` literal at all: both
    // release readers pass the WHOLE env object into a function (`resolveHome`,
    // `childEnvFor`). So the name sweep was passing vacuously, and a new reader spelled the
    // same way would have shipped unexamined. Whole-object reads must be counted and capped.
    const reads = Array.from({ length: ALLOWED_WHOLE_ENV_READS + 1 }, () => '{...process.env}').join(';');
    const problems = checkBundle(`${CLEAN} ${reads};`);
    assert.ok(
      problems.some((p) => /whole environment|process\.env/i.test(p)),
      `expected an unreviewed whole-env read to be caught, got ${JSON.stringify(problems)}`,
    );
  });

  it('declares exactly ONE whole-environment read — the brain registry’s — and admits it (B1)', () => {
    // The count was three (`resolveHome`, `createClaudeBrain`, `probeBrain`): every reader
    // took the parent environment for itself. The registry now takes it once and hands it on.
    assert.equal(ALLOWED_WHOLE_ENV_READS, 1);
    assert.deepEqual(checkBundle(`${CLEAN} const registry = createRegistry({ env: process.env });`), []);
  });

  it('names a SECOND whole-environment read as a finding, and says where the one read lives (B4)', () => {
    // The mutant: a new driver that reaches for the parent environment on its own instead of
    // taking the registry's — the shape that forwards an API key to an agent's child.
    const problems = checkBundle(`${CLEAN} createRegistry({ env: process.env }); spawn('codex', args, { env: process.env });`);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /whole environment 2 times/);
    assert.match(problems[0], /brains\/registry\.ts/);
    // Not an invitation to raise the number.
    assert.doesNotMatch(problems[0], /count raised|raise the count/i);
  });

  it('catches a bundle that lost its tool surface', () => {
    const problems = checkBundle('const home = process.env.HOME;');
    assert.ok(problems.some((p) => p.includes('tool surface')));
  });

  it('never admits a credential-shaped name into the allowlist itself', () => {
    for (const name of ALLOWED_ENV_READS) {
      assert.ok(!/KEY|TOKEN|SECRET|ANTHROPIC|CLAUDE/i.test(name), `${name} does not belong in the env allowlist`);
    }
  });
});

describe('the instructions byte-compare (D-B12)', () => {
  const instructions = 'Call snug_status first.\nThen snug_open.\n';

  it('passes when the bundle carries the source text', () => {
    const bundled = `var i = ${JSON.stringify(instructions)};`;
    assert.deepEqual(checkInstructions(bundled, instructions), []);
  });

  it('catches a bundle built from a STALE copy', () => {
    // The mutant: someone edits instructions.md and ships yesterday's bundle.
    const bundled = `var i = ${JSON.stringify('Call snug_status first.\n')};`;
    assert.equal(checkInstructions(bundled, instructions).length, 1);
  });
});

describe('what the instructions tell an agent — sent at MCP initialize, and spliced into the skill', () => {
  // The byte-compare above proves the bundle carries THIS text; nothing proved the text was
  // still true. Two things changed under it in TASK-20261003: a hand-in from the agent
  // installs an app again even if the user had deleted it (K6 — the runner clears the
  // tombstone for an explicit hand-in), and `snug_hand_in` answers with what the page did
  // with the bundle instead of "handed to the open runner" whatever happened.
  const instructions = readFileSync(INSTRUCTIONS_FILE, 'utf8');
  const lines = instructions.split('\n');
  /** The text as sentences: a claim must not hide across a wrapped line. */
  const said = instructions.replace(/\s+/g, ' ');
  const handingOver = said.split('## Handing an app over')[1].split('## What you do not do here')[0];

  it('no longer says a hand-in "never restores" a deleted app — on the runner that is false', () => {
    assert.doesNotMatch(said, /never restores/);
  });

  it('says, in ONE plain sentence, that an explicit hand-in installs the app again even if the user had deleted it', () => {
    const sentences = handingOver.split(/(?<=\.)\s+/).filter((sentence) => /deleted/.test(sentence));
    assert.deepEqual(sentences, ['An explicit hand-in installs the app again even if the user had deleted it.']);
  });

  it('still says an edited copy is offered the update and never overwritten silently', () => {
    assert.match(handingOver, /offers the update in its run header when the user has edited their copy/);
    assert.match(handingOver, /never overwrites an edited app silently/);
  });

  it('says what each of `snug_hand_in`’s answers means, in at most four lines', () => {
    const first = lines.findIndex((line) => line.includes('`snug_hand_in` answers'));
    const last = lines.map((line) => line.includes('not confirmed')).lastIndexOf(true);
    assert.ok(first >= 0, 'the instructions never say that `snug_hand_in` answers');
    assert.ok(last >= first, 'the instructions never mention the unconfirmed answer');
    // This text is in every session's context.
    const passage = lines.slice(first, last + 1);
    assert.ok(passage.length <= 4, `the answers take ${passage.length} lines`);
    assert.ok(passage.every((line) => line.trim() !== ''), 'the answers are one paragraph');
    const answers = passage.join(' ');
    // Every answer the process gives (`handInAnswer` in apps/host-mcp/src/runner.ts), by its first word.
    for (const answer of ['`installed`', '`updated`', '`current`', '`offered`', '`refused: <reason>`', '`sent … — not confirmed`']) {
      assert.ok(answers.includes(answer), `the instructions do not name the answer ${answer}`);
    }
    assert.match(answers, /to vN/);
    // …and what the three that are not "done" mean for the agent's next step.
    assert.match(answers, /`offered`: the user edited their copy, so the update waits for them/);
    assert.match(answers, /`refused: <reason>`: nothing changed/);
    assert.match(answers, /`sent … — not confirmed`: the page did not report back/);
    // It belongs to the hand-in section, after the sentence about a deleted app.
    assert.ok(first > lines.findIndex((line) => line.includes('even if the user had deleted it')));
    assert.ok(last < lines.findIndex((line) => line.includes('## What you do not do here')));
  });

  it('never says the thinks run on a "Claude CLI" — the brain is the user’s own agent CLI, Claude by default (ADR-0071)', () => {
    assert.doesNotMatch(said, /Claude CLI/);
    // What it does say about the brain is the one neutral clause: `snug_status` names it.
    assert.match(said, /which brain answers the apps/);
  });

  it('lands in the skill under THE LOCAL RUNNER — the deleted-app sentence is not true of an artifact, and must not read as if it were', () => {
    // An artifact page re-reads its embedded bundles on every load, so there an app the user
    // deleted stays deleted (Binding A's rule — the one difference the parity test states).
    const skill = renderSkill({ source: readFileSync(SKILL_SOURCE, 'utf8'), instructions });
    const sentence = skill.indexOf('An explicit hand-in installs the app again even if the user had deleted it.');
    assert.ok(sentence > skill.indexOf('### The local runner'), 'the sentence is missing from the rendered skill, or above the local runner');
    assert.ok(sentence < skill.indexOf('### The artifact runner'));
    assert.equal(skill.split('even if the user had deleted it').length - 1, 1);
    // The answers are said ONCE, by the launch protocol; the skill's own text does not restate them.
    assert.equal(skill.split('not confirmed').length - 1, 1);
  });
});

describe('the plugin tree', () => {
  /** A real build over fake inputs, then a mutation — the gate must see it. */
  const built = async () => {
    const { dir, out, sources } = fixtures();
    assert.deepEqual(await buildPlugin(out, sources, { skill: FAKE_SKILL, commit: 'abc123' }), []);
    return { dir, out };
  };
  const check = (out) => checkPluginTree(out, { skill: FAKE_SKILL });

  it('passes a tree the builder wrote', async () => {
    const { dir, out } = await built();
    try {
      assert.deepEqual(await check(out), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names what is missing from a folder that holds no plugin at all — a list, never a throw', async () => {
    const { dir, out } = await built();
    rmSync(path.join(out, 'snug'), { recursive: true });
    try {
      const problems = await check(out);
      assert.ok(problems.some((p) => p.includes('missing snug/.claude-plugin/plugin.json')), JSON.stringify(problems));
      assert.ok(problems.some((p) => p.includes('missing the runner page')), JSON.stringify(problems));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a hand-edited manifest', async () => {
    // The mutant: the "one contract, two artifacts" defect this module exists to prevent.
    const { dir, out } = await built();
    const file = path.join(out, 'snug/.claude-plugin/plugin.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: '9.9.9' }));
    try {
      assert.ok((await check(out)).some((p) => p.includes('plugin.json') && p.includes('plugin-manifests')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a server command pointed somewhere else', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/.mcp.json'), JSON.stringify({ mcpServers: { snug: { command: 'node', args: ['/tmp/whatever.mjs'] } } }));
    try {
      assert.ok((await check(out)).some((p) => p.includes('.mcp.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a missing launcher — the manifest runs it, so a tree without it starts nothing (AC3)', async () => {
    const { dir, out } = await built();
    rmSync(path.join(out, 'snug/scripts/snug'));
    try {
      assert.ok((await check(out)).some((p) => p.includes('launcher')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a missing runner page — the ONE page, the skill’s asset (K1)', async () => {
    // MIGRATED 2026-10-03: the page was a second build shipped beside the bundle. It is the
    // skill's asset now, which the process finds relative to its bundle.
    const { dir, out } = await built();
    rmSync(path.join(out, 'snug', PAGE_PATH));
    try {
      assert.ok((await check(out)).some((p) => p.includes('runner page')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a SECOND copy of the page beside the bundle — the plugin ships it once', async () => {
    // The mutant: a build step that copies the page next to the process "to be safe". The
    // process would never read it (its first home is the skill's asset), so the two would
    // drift in silence, and the plugin would be 2 MB heavier for it.
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/scripts/snug-host.html'), '<!doctype html><title>a second copy</title>');
    try {
      assert.ok((await check(out)).some((p) => /second copy of the page/.test(p) && p.includes('scripts/snug-host.html')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a SKILL.md edited in the tree rather than in its source (AC1)', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/skills/snug/SKILL.md'), '---\nname: snug\n---\n# edited by hand');
    try {
      assert.ok((await check(out)).some((p) => p.includes('SKILL.md') && p.includes('fresh render')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a plugin that grew a hooks/ directory (ADR-0069: no hooks)', async () => {
    const { dir, out } = await built();
    mkdirSync(path.join(out, 'snug/hooks'), { recursive: true });
    writeFileSync(path.join(out, 'snug/hooks/hooks.json'), '{}');
    try {
      assert.ok((await check(out)).some((p) => p.includes('hooks')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a manifest that is not JSON, by name', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/.mcp.json'), '{nope');
    try {
      assert.ok((await check(out)).some((p) => p.includes('.mcp.json') && p.includes('not JSON')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a file changed after the provenance was written', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/scripts/snug-mcp.mjs'), '// replaced');
    try {
      assert.ok((await check(out)).some((p) => p.includes('PROVENANCE') && p.includes('snug-mcp.mjs')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('the page’s pin (D8)', () => {
    // The provenance cannot see either of these: it hashes whatever the build wrote, so a
    // build that wrote no pin, or the wrong one, would describe its own tree perfectly.

    it('catches a tree with NO pin beside its page — every install of it would serve whatever page it found', async () => {
      const { dir, out } = await built();
      rmSync(path.join(out, 'snug', PAGE_PIN_PATH));
      try {
        assert.ok((await check(out)).some((p) => /missing the page’s pin/.test(p) && p.includes(PAGE_PIN_PATH)), JSON.stringify(await check(out)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('catches a pin that names some other page — the process would refuse to lead from a fresh install', async () => {
      const { dir, out } = await built();
      writeFileSync(path.join(out, 'snug', PAGE_PIN_PATH), `${sha256('yesterday’s page')}  snug-host.html\n`);
      try {
        assert.ok((await check(out)).some((p) => /pin .*does not name the sha256 of the page/.test(p)), JSON.stringify(await check(out)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reads the pin as the process does: the first token, in either case', async () => {
      const { dir, out } = await built();
      const pin = path.join(out, 'snug', PAGE_PIN_PATH);
      writeFileSync(pin, readFileSync(pin, 'utf8').toUpperCase().replace('SNUG-HOST.HTML', 'snug-host.html'));
      try {
        assert.ok(!(await check(out)).some((p) => /pin/.test(p) && !p.includes('PROVENANCE')), JSON.stringify(await check(out)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('holds the tree to the directory’s install-blocking rules (D2 — each rule’s own mutant is in build-plugin.test.mjs)', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/skills/.DS_Store'), '');
    try {
      assert.ok((await check(out)).some((p) => /plugin directory would refuse/.test(p) && p.includes('skills/.DS_Store')), JSON.stringify(await check(out)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('the upload archive is the plugin folder — whole, byte for byte, and nothing else (D3)', () => {
    /** A built tree whose archive has been REWRITTEN from the tree's own entries, changed by `change`. */
    const rearchived = async (change) => {
      const { dir, out } = await built();
      writeFileSync(path.join(out, ARCHIVE_NAME), createZip(change(archiveEntries(path.join(out, 'snug')))));
      return { dir, out };
    };
    const caught = async ({ dir, out }, pattern) => {
      try {
        // Through the whole tree check AND on its own: the rule is wired in, and it is this rule.
        assert.ok((await check(out)).some((p) => pattern.test(p)), JSON.stringify(await check(out)));
        assert.ok(checkArchive(out).some((p) => pattern.test(p)), JSON.stringify(checkArchive(out)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('passes the archive the builder wrote — and one rewritten from the same entries', async () => {
      const { dir, out } = await rearchived((entries) => entries);
      try {
        assert.deepEqual(checkArchive(out), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('catches a tree with no archive', async () => {
      const { dir, out } = await built();
      rmSync(path.join(out, ARCHIVE_NAME));
      await caught({ dir, out }, /snug\.zip is missing/);
    });

    it('catches an entry whose bytes are not the tree’s file', async () => {
      await caught(
        await rearchived((entries) => entries.map((entry) => (entry.name === 'snug/README.md' ? { ...entry, data: Buffer.from('# another README') } : entry))),
        /snug\.zip: snug\/README\.md is not the tree’s file/,
      );
    });

    it('catches a tree changed AFTER it was archived — the archive would upload yesterday’s file', async () => {
      const { dir, out } = await built();
      writeFileSync(path.join(out, 'snug/README.md'), `${readFileSync(path.join(out, 'snug/README.md'), 'utf8')}\nedited`);
      await caught({ dir, out }, /snug\.zip: snug\/README\.md is not the tree’s file/);
    });

    it('catches a file of the tree the archive left out', async () => {
      await caught(await rearchived((entries) => entries.filter((entry) => entry.name !== `snug/${PAGE_PIN_PATH}`)), /snug\.zip is missing snug\/skills\/snug\/assets\/snug-host\.html\.sha256/);
    });

    it('catches an entry the tree does not have', async () => {
      await caught(await rearchived((entries) => [...entries, { name: 'snug/scripts/extra.mjs', data: Buffer.from('// extra'), mode: 0o644 }]), /snug\.zip carries snug\/scripts\/extra\.mjs, which is not in the tree/);
    });

    it('catches a SECOND top-level entry — the marketplace root’s files are not part of the upload', async () => {
      await caught(await rearchived((entries) => [...entries, { name: 'PROVENANCE.json', data: Buffer.from('{}'), mode: 0o644 }]), /ONE top-level entry.*PROVENANCE\.json/);
    });

    it('catches a second top-level entry wherever it sorts, and the folder under any other name', async () => {
      await caught(await rearchived((entries) => [...entries, { name: 'zz-notes.txt', data: Buffer.from('x'), mode: 0o644 }]), /ONE top-level entry.*zz-notes\.txt/);
      await caught(await rearchived((entries) => entries.map((entry) => ({ ...entry, name: `plugin/${entry.name.slice('snug/'.length)}` }))), /ONE top-level entry, snug\/.* it holds: plugin$/);
    });

    it('catches an archive of the folder’s CONTENTS with no folder around them', async () => {
      await caught(await rearchived((entries) => entries.map((entry) => ({ ...entry, name: entry.name.slice('snug/'.length) }))), /ONE top-level entry/);
    });

    it('catches a launcher that would unzip without its executable bit', async () => {
      await caught(
        await rearchived((entries) => entries.map((entry) => (entry.name === `snug/${LAUNCHER_PATH}` ? { ...entry, mode: 0o644 } : entry))),
        /snug\.zip: snug\/scripts\/snug has mode 644 where the tree’s file is 755/,
      );
    });

    it('catches an archive that does not read back — by name, not by a throw', async () => {
      const { dir, out } = await built();
      const archive = readFileSync(path.join(out, ARCHIVE_NAME));
      archive[archive.indexOf(Buffer.from('MIT License'))] ^= 1; // one bit of a stored file
      writeFileSync(path.join(out, ARCHIVE_NAME), archive);
      await caught({ dir, out }, /snug\.zip does not read back: zip: snug\/LICENSE: CRC mismatch/);
    });
  });
});

describe('the release bundle’s size against the directory’s reviewer-hold line (D2)', () => {
  it('the line is 256 KiB', () => {
    assert.equal(REVIEWER_HOLD_BYTES, 256 * 1024);
  });

  it('says how far OVER the line a bundle is — the figure a reviewer of a growing bundle needs', () => {
    assert.equal(bundleSizeLine(282_046), 'the release bundle is 282,046 bytes — 19,902 OVER the plugin directory’s 256 KiB reviewer-hold line (262,144)');
  });

  it('says how far under it a bundle is, and a bundle exactly on the line is not over it', () => {
    assert.equal(bundleSizeLine(200_000), 'the release bundle is 200,000 bytes — 62,144 under the plugin directory’s 256 KiB reviewer-hold line (262,144)');
    assert.match(bundleSizeLine(REVIEWER_HOLD_BYTES), /— 0 under /);
  });

  it('is a line, never a problem: `checkBundle` does not fail a bundle for its size', () => {
    // Printed so growth is seen in review; whether to hold a plugin is the directory's call.
    assert.deepEqual(checkBundle(`${CLEAN} /* ${'x'.repeat(REVIEWER_HOLD_BYTES)} */`), []);
  });
});

describe('the external validators', () => {
  it('reports an absent validator as NOT VERIFIED, never as a pass', () => {
    const exec = () => {
      const error = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      throw error;
    };
    const results = runValidators('/nowhere', exec);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'not verified'));
  });

  // Measured 2026-10-04: an interrupted claude-code install left a non-executable 500-byte
  // stub as `claude` on PATH; the spawn's EACCES read as "refused the tree:" with no words.
  // A validator that cannot START vouches for nothing either way — NOT VERIFIED, with why.
  for (const code of ['EACCES', 'ENOEXEC']) {
    it(`reports a validator that cannot start (${code}) as NOT VERIFIED, naming why — never as a refusal`, () => {
      const exec = (command) => {
        const error = new Error(`spawn ${command} ${code}`);
        error.code = code;
        throw error;
      };
      const results = runValidators('/nowhere', exec);
      assert.ok(results.every((r) => r.status === 'not verified'));
      assert.match(results[0].detail, new RegExp(`claude is on this machine but cannot run \\(${code}\\)`));
    });
  }

  it('reports a refusal as failed, with the validator’s own words', () => {
    const exec = () => {
      const error = new Error('exit 1');
      error.status = 1;
      error.stdout = '';
      error.stderr = 'x Validation failed: description too long';
      throw error;
    };
    const results = runValidators('/nowhere', exec);
    assert.ok(results.every((r) => r.status === 'failed' && r.detail.includes('description too long')));
  });

  it('reports a pass as ok', () => {
    const results = runValidators('/nowhere', () => '✔ Validation passed\n');
    assert.ok(results.every((r) => r.status === 'ok'));
  });
});

describe('the launch legs — the gate STARTS what it ships (D1)', () => {
  // The plugin gate used to check the tree's FILES and never run them, which is how a
  // plugin that could not attach to its own runner shipped as "marketplace-ready". The legs
  // start the launcher the tree ships and speak to it as a host does. These tests drive the
  // legs with launchers that MISBEHAVE, because a leg that cannot be shown to fail vouches
  // for nothing — and because the first thing a leg must prove is that it is not talking
  // to the developer's real Snug.

  /**
   * NO LEG LEAVES A PROCESS BEHIND, however it ended — passed, aborted, or caught a launcher
   * misbehaving. Two tests below make that their subject; this makes it true of all of them:
   * every fake launcher reports the processes still alive when it is removed, and a test
   * that left one fails here, by pid.
   */
  const outlived = [];
  afterEach(() => {
    assert.deepEqual(outlived.splice(0), [], 'a launch leg left a process running');
  });

  /** What an honest fake serves at `/` — and what a test hands the leg as the page the tree ships. */
  const PAGE = '<!doctype html><title>kit</title><p>the page the tree ships';

  /** A launcher whose process answers as `mode` says. Every start is logged, with its pid. */
  const fake = (mode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-leg-'));
    const starts = path.join(dir, 'starts.log');
    const script = path.join(dir, 'fake-runner.mjs');
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
const home = process.env.SNUG_HOME;
// The document a runner serves at / — or, for a tree whose page is not where the process
// looks, the placeholder it serves in its place (with HTTP 200, which is the whole problem).
const served = mode === 'serves-placeholder' ? '<!doctype html><title>Snug</title><p>The Snug runner page is missing from this install.' : ${JSON.stringify(PAGE)};
let port = 0;
if (home !== undefined && mode !== 'serves-nothing') {
  const server = createServer((request, response) => response.end(served));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}
const status = () => {
  if (home === undefined) {
    if (mode === 'resolves-a-home-anyway') return { running: true, pid: process.pid, home: '/Users/someone/Snug', file: '/Users/someone/Snug/user.snug' };
    return { running: false, refusal: { code: mode === 'wrong-refusal' ? 'listen-failed' : 'home-unresolved', message: 'no home', remedy: 'set one' } };
  }
  mkdirSync(home, { recursive: true });
  const record = path.join(home, 'primary.pid');
  const base = {
    running: true,
    port,
    home: mode === 'leaks-home' ? '/Users/someone/Snug' : home,
    file: mode === 'leaks-file' ? '/Users/someone/Snug/user.snug' : path.join(home, 'user.snug'),
  };
  if (existsSync(record) && mode !== 'never-attaches') return { ...base, attached: true, pid: Number(readFileSync(record, 'utf8')) };
  writeFileSync(record, String(process.pid));
  return { ...base, pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid };
};
// A process that ignores both ways of being asked: something must keep it alive once its
// input has ended, or it would simply fall off the end of its event loop.
if (mode === 'lingers') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000); }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || mode === 'silent') return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snug', version: '0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps'].map((name) => ({ name })) });
  else reply(message.id, { content: [{ type: 'text', text: JSON.stringify(status()) }] });
});
process.stdin.on('end', () => { if (mode !== 'lingers') process.exit(0); });
`,
    );
    const launcher = path.join(dir, 'snug');
    // What the real launcher ends with: `exec` — so the launcher's pid IS the process's pid.
    writeFileSync(launcher, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    const pids = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').map(Number) : []);
    return {
      launcher,
      pids,
      remove: () => {
        // Looked at BEFORE the log goes: these are the processes this launcher started.
        outlived.push(...pids().filter(alive));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const quick = { requestTimeoutMs: 1_500, reapMs: 1_000 };

  it('the isolation environment is exactly three variables — never the developer’s own', () => {
    const env = isolationEnv('/tmp/x');
    assert.deepEqual(env, { HOME: '/tmp/x', SNUG_HOME: '/tmp/x/Snug', PATH: path.dirname(process.execPath) });
  });

  it('passes a launcher whose process leads, is joined by a second, and refuses with no home', async () => {
    const f = fake('honest');
    try {
      assert.deepEqual(await runLaunchLegs(f.launcher, quick), []);
      // Two for the positive leg, one for the negative — and every one of them reaped.
      assert.equal(f.pids().length, 3);
      for (const pid of f.pids()) assert.equal(alive(pid), false, `pid ${pid} was left running`);
    } finally {
      f.remove();
    }
  });

  it('ABORTS the positive leg when the status names a home outside its temp directory — before a second process exists', async () => {
    // The mutant that matters most: a build that ignores SNUG_HOME. The leg would otherwise
    // go on to start a second process against whatever home that was.
    const f = fake('leaks-home');
    try {
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /isolation/i.test(p) && p.includes('/Users/someone/Snug')), JSON.stringify(problems));
      assert.equal(f.pids().length, 2, 'the positive leg must stop at ONE process (the negative leg starts the other)');
    } finally {
      f.remove();
    }
  });

  it('ABORTS the positive leg when the status names a FILE outside its temp directory — a home in the right place is not enough', async () => {
    // The file is what gets written. A build that reports the home it was given and keeps
    // the user file somewhere else is the 2026-09-07 data loss with a reassuring status.
    const f = fake('leaks-file');
    try {
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /isolation/i.test(p) && p.includes('/Users/someone/Snug/user.snug')), JSON.stringify(problems));
      assert.equal(f.pids().length, 2, 'the positive leg must stop at ONE process (the negative leg starts the other)');
    } finally {
      f.remove();
    }
  });

  it('ABORTS the positive leg when the status’s pid is not the process the leg started', async () => {
    // A status from some OTHER runner means the leg attached to something it did not spawn.
    const f = fake('wrong-pid');
    try {
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /isolation/i.test(p) && /pid/.test(p)), JSON.stringify(problems));
      assert.equal(f.pids().length, 2);
    } finally {
      f.remove();
    }
  });

  it('catches a second process that does not attach — the defect this range exists for', async () => {
    const f = fake('never-attaches');
    try {
      assert.ok((await runLaunchLegs(f.launcher, quick)).some((p) => /did not attach/.test(p)));
    } finally {
      f.remove();
    }
  });

  it('catches a process that RESOLVES a home when none was given', async () => {
    const f = fake('resolves-a-home-anyway');
    try {
      assert.ok((await runLaunchLegs(f.launcher, quick)).some((p) => /negative leg/.test(p) && /home-unresolved/.test(p)));
    } finally {
      f.remove();
    }
  });

  it('catches the wrong refusal', async () => {
    const f = fake('wrong-refusal');
    try {
      assert.ok((await runLaunchLegs(f.launcher, quick)).some((p) => /negative leg/.test(p) && /listen-failed/.test(p)));
    } finally {
      f.remove();
    }
  });

  it('catches a launcher that never completes the handshake, by name — and does not hang', async () => {
    const f = fake('silent');
    try {
      const began = Date.now();
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /positive leg/.test(p) && /initialize/.test(p)), JSON.stringify(problems));
      assert.ok(problems.some((p) => /negative leg/.test(p) && /initialize/.test(p)), JSON.stringify(problems));
      assert.ok(Date.now() - began < 15_000);
    } finally {
      f.remove();
    }
  });

  describe('the process SERVES the page the tree ships (K1)', () => {
    // The page is found by the process relative to its bundle, and a page it cannot find is
    // served as a placeholder with HTTP 200 — so nothing that reads files can see a layout
    // that moved one side and not the other. The leg asks the started process for `/`.
    const shipped = () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'snug-leg-page-'));
      const file = path.join(dir, 'snug-host.html');
      writeFileSync(file, PAGE);
      return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
    };

    it('passes when what is served at / is the shipped page, byte for byte', async () => {
      const f = fake('honest');
      const page = shipped();
      try {
        assert.deepEqual(await runLaunchLegs(f.launcher, { ...quick, page: page.file }), []);
      } finally {
        f.remove();
        page.remove();
      }
    });

    it('catches a process serving the "page is missing" placeholder — a 200 that is not the page', async () => {
      const f = fake('serves-placeholder');
      const page = shipped();
      try {
        const problems = await runLaunchLegs(f.launcher, { ...quick, page: page.file });
        assert.ok(problems.some((p) => /positive leg/.test(p) && /does not serve the page the tree ships/.test(p) && /missing from this install/.test(p)), JSON.stringify(problems));
      } finally {
        f.remove();
        page.remove();
      }
    });

    it('catches a process that serves nothing at its address', async () => {
      const f = fake('serves-nothing');
      const page = shipped();
      try {
        const problems = await runLaunchLegs(f.launcher, { ...quick, page: page.file });
        assert.ok(problems.some((p) => /positive leg/.test(p) && /does not serve the page the tree ships/.test(p)), JSON.stringify(problems));
      } finally {
        f.remove();
        page.remove();
      }
    });

    it('with no page named, the leg asks for none (a caller that only has a launcher)', async () => {
      const f = fake('serves-placeholder');
      try {
        assert.deepEqual(await runLaunchLegs(f.launcher, quick), []);
      } finally {
        f.remove();
      }
    });
  });

  it('catches a launcher that is not there', async () => {
    const problems = await runLaunchLegs('/nowhere/scripts/snug', quick);
    assert.ok(problems.length >= 2);
  });

  describe('the PIN, proven on the tree: one changed byte of the page and the install refuses to lead (D8)', () => {
    // The build writes the page's sha256 beside it and the process serves only bytes that
    // match. Nothing that reads files can show the two halves meet: a build that pinned the
    // wrong file, or a process that stopped reading the pin, leaves every hash in the tree
    // correct. So the leg damages a COPY of the tree and starts it.

    /**
     * A plugin folder whose launcher starts a runner that treats the page as the real
     * process does: `skills/snug/assets/snug-host.html`, relative to its own script, pinned
     * by the `.sha256` beside it. Every start is logged with its pid and the script it ran.
     */
    const fakePlugin = (mode) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'snug-leg-tree-'));
      const plugin = path.join(dir, 'snug');
      // Outside the plugin folder: a copy of the tree does not take the log with it.
      const starts = path.join(dir, 'starts.log');
      mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
      mkdirSync(path.join(plugin, path.dirname(PAGE_PATH)), { recursive: true });
      writeFileSync(path.join(plugin, PAGE_PATH), PAGE);
      if (mode !== 'unpinned') writeFileSync(path.join(plugin, PAGE_PIN_PATH), `${sha256(PAGE)}  snug-host.html\n`);
      writeFileSync(
        path.join(plugin, 'scripts/fake-runner.mjs'),
        `import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const mode = ${JSON.stringify(mode)};
const here = path.dirname(fileURLToPath(import.meta.url));
appendFileSync(${JSON.stringify(starts)}, process.pid + ' ' + here + '\\n');
const home = process.env.SNUG_HOME;
const page = path.join(here, '..', ${JSON.stringify(PAGE_PATH)});
const pin = existsSync(page + '.sha256') ? readFileSync(page + '.sha256', 'utf8').split(/\\s+/)[0] : undefined;
const mismatch = pin !== undefined && pin !== createHash('sha256').update(readFileSync(page)).digest('hex');
const damaged = mode === 'refuses-everything' || (mode !== 'ignores-pin' && mismatch);
const status = () => {
  const refusal = { code: mode === 'wrong-refusal' ? 'listen-failed' : 'page-damaged', message: 'damaged', remedy: 'reinstall' };
  if (damaged && mode !== 'leads-and-says-damaged') return { running: false, refusal };
  mkdirSync(home, { recursive: true });
  return {
    running: true,
    pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid,
    home: mode === 'leaks-home' ? '/Users/someone/Snug' : home,
    file: path.join(home, 'user.snug'),
    ...(damaged ? { refusal } : {}),
  };
};
if (mode === 'lingers') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000); }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || mode === 'silent') return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snug', version: '0' } });
  else reply(message.id, { content: [{ type: 'text', text: JSON.stringify(status()) }] });
});
process.stdin.on('end', () => { if (mode !== 'lingers') process.exit(0); });
`,
      );
      // Shell builtins only, as the real launcher: under the isolation environment the PATH
      // holds node and nothing else — there is no `dirname` to call.
      writeFileSync(path.join(plugin, LAUNCHER_PATH), '#!/bin/sh\nexec node "${0%/*}/fake-runner.mjs" "$@"\n', { mode: 0o755 });
      const log = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').map((line) => ({ pid: Number(line.split(' ')[0]), ranFrom: line.slice(line.indexOf(' ') + 1) })) : []);
      return {
        plugin,
        log,
        remove: () => {
          outlived.push(...log().map((start) => start.pid).filter(alive));
          rmSync(dir, { recursive: true, force: true });
        },
      };
    };

    it('passes a tree whose damaged copy refuses and which itself still leads — and never touches the tree it was given', async () => {
      const f = fakePlugin('honest');
      try {
        assert.deepEqual(await runDamagedPageLeg(f.plugin, quick), []);
        const [damaged, untouched] = f.log();
        assert.equal(f.log().length, 2);
        // The damaged one ran from a COPY, which is gone; the untouched one from the tree
        // itself. (Real paths: a process names its own script through /private on a Mac.)
        const scripts = realpathSync(path.join(f.plugin, 'scripts'));
        assert.notEqual(damaged.ranFrom, scripts);
        assert.equal(existsSync(damaged.ranFrom), false, 'the leg left its damaged copy behind');
        assert.equal(untouched.ranFrom, scripts);
        assert.equal(readFileSync(path.join(f.plugin, PAGE_PATH), 'utf8'), PAGE);
        assert.equal(readFileSync(path.join(f.plugin, PAGE_PIN_PATH), 'utf8'), `${sha256(PAGE)}  snug-host.html\n`);
        for (const { pid } of f.log()) assert.equal(alive(pid), false, `pid ${pid} was left running`);
      } finally {
        f.remove();
      }
    });

    it('catches a tree with NO pin: its damaged copy leads, serving a page that is not the one it was built with', async () => {
      // The mutant the leg exists for — the build that forgot the pin.
      const f = fakePlugin('unpinned');
      try {
        const problems = await runDamagedPageLeg(f.plugin, quick);
        assert.ok(problems.some((p) => /damaged-page leg/.test(p) && /must refuse to lead \(page-damaged\)/.test(p)), JSON.stringify(problems));
        // …and it stops there: a copy that led holds the leg's lock, so a second process would only attach to it.
        assert.equal(f.log().length, 1);
      } finally {
        f.remove();
      }
    });

    it('catches a process that does not read the pin', async () => {
      const f = fakePlugin('ignores-pin');
      try {
        assert.ok((await runDamagedPageLeg(f.plugin, quick)).some((p) => /damaged-page leg/.test(p) && /must refuse to lead \(page-damaged\)/.test(p)));
      } finally {
        f.remove();
      }
    });

    it('catches a damaged copy that names the refusal and LEADS anyway — the code alone is not the refusal', async () => {
      const f = fakePlugin('leads-and-says-damaged');
      try {
        assert.ok((await runDamagedPageLeg(f.plugin, quick)).some((p) => /damaged-page leg/.test(p) && /must refuse to lead \(page-damaged\)/.test(p)));
        assert.equal(f.log().length, 1);
      } finally {
        f.remove();
      }
    });

    it('catches a damaged copy that refuses for some OTHER reason — the leg proves the pin, not that something went wrong', async () => {
      const f = fakePlugin('wrong-refusal');
      try {
        assert.ok((await runDamagedPageLeg(f.plugin, quick)).some((p) => /damaged-page leg/.test(p) && /listen-failed/.test(p)));
      } finally {
        f.remove();
      }
    });

    it('catches a tree that refuses UNTOUCHED — a pin of the wrong page passes the first half on its own', async () => {
      const f = fakePlugin('refuses-everything');
      try {
        const problems = await runDamagedPageLeg(f.plugin, quick);
        assert.ok(problems.some((p) => /damaged-page leg/.test(p) && /untouched tree must still lead/.test(p) && /page-damaged/.test(p)), JSON.stringify(problems));
        assert.equal(problems.length, 1);
      } finally {
        f.remove();
      }
    });

    for (const [mode, names] of [
      ['leaks-home', /\/Users\/someone\/Snug/],
      ['wrong-pid', /pid/],
    ]) {
      it(`catches an untouched tree that does not lead on the leg’s OWN home (${mode})`, async () => {
        const f = fakePlugin(mode);
        try {
          const problems = await runDamagedPageLeg(f.plugin, quick);
          assert.ok(problems.some((p) => /damaged-page leg/.test(p) && /isolation/i.test(p) && names.test(p)), JSON.stringify(problems));
        } finally {
          f.remove();
        }
      });
    }

    it('catches a launcher that never answers, by name — and does not hang', async () => {
      const f = fakePlugin('silent');
      try {
        const began = Date.now();
        assert.ok((await runDamagedPageLeg(f.plugin, quick)).some((p) => /damaged-page leg/.test(p) && /initialize/.test(p)));
        assert.ok(Date.now() - began < 15_000);
      } finally {
        f.remove();
      }
    });

    it('catches a tree that is not there, and one with no page to damage', async () => {
      assert.ok((await runDamagedPageLeg('/nowhere/snug', quick)).some((p) => /damaged-page leg/.test(p)));
      const f = fakePlugin('honest');
      rmSync(path.join(f.plugin, PAGE_PATH));
      try {
        assert.ok((await runDamagedPageLeg(f.plugin, quick)).some((p) => /damaged-page leg/.test(p)));
        assert.equal(f.log().length, 0, 'nothing is started when there is no page to damage');
      } finally {
        f.remove();
      }
    });

    it('REAPS both processes however they behave', async () => {
      const f = fakePlugin('lingers');
      try {
        await runDamagedPageLeg(f.plugin, quick);
        assert.equal(f.log().length, 2);
        for (const { pid } of f.log()) assert.equal(alive(pid), false, `pid ${pid} outlived the leg`);
      } finally {
        f.remove();
      }
    });
  });

  it('REAPS a process that will not go: closing its input and a SIGTERM are followed, after the bound, by a SIGKILL', async () => {
    const f = fake('lingers');
    try {
      await runLaunchLegs(f.launcher, quick);
      assert.equal(f.pids().length, 3);
      for (const pid of f.pids()) assert.equal(alive(pid), false, `pid ${pid} outlived the leg`);
    } finally {
      f.remove();
    }
  });
});

describe('the gate, whole: it CALLS every rule it has', () => {
  // The R2 verifier's finding: with the launch legs and the damaged-page leg called inline
  // in `main()`, deleting either call left every suite green. Each leg had its own tests;
  // nothing tested that the gate runs them. `runGate` is `main()`'s body with its
  // collaborators as parameters, and these tests drive it over a real build of fixture inputs.

  const instructions = readFileSync(INSTRUCTIONS_FILE, 'utf8');
  /** Fixture inputs whose "release bundle" passes the sweep and carries the real instructions. */
  const gateFixtures = (bundle = `${CLEAN} export const instructions = ${JSON.stringify(instructions)};`) => {
    const fixture = fixtures();
    writeFileSync(fixture.sources.bundle, bundle);
    return fixture;
  };
  /** Legs that record how they were called and answer what the test says. */
  const recordingLegs = (answers = {}) => {
    const calls = [];
    const leg = (name) => async (...args) => {
      calls.push([name, ...args]);
      return answers[name] ?? [];
    };
    return { calls, legs: { launch: leg('launch'), damagedPage: leg('damagedPage') } };
  };
  const gate = ({ out, sources }, options = {}) =>
    runGate({ bundleFile: sources.bundle, pluginDir: out, sources, skill: FAKE_SKILL, validators: () => [], ...options });
  const sizeLine = (sources) => `SIZE — ${bundleSizeLine(readFileSync(sources.bundle).length)}`;

  it('a clean tree is STARTED: both launch legs and the damaged-page leg are called, on the tree the gate just built', async () => {
    const fixture = gateFixtures();
    const { calls, legs } = recordingLegs();
    try {
      const { lines, problems } = await gate(fixture, { legs });
      assert.deepEqual(problems, []);
      const plugin = path.join(fixture.out, 'snug');
      assert.deepEqual(calls, [
        // The launcher the tree ships, and the page it must be found serving.
        ['launch', path.join(plugin, LAUNCHER_PATH), { page: path.join(plugin, PAGE_PATH) }],
        ['damagedPage', plugin],
      ]);
      assert.ok(existsSync(path.join(plugin, LAUNCHER_PATH)), 'the gate must have BUILT the tree it starts');
      assert.equal(lines[0], sizeLine(fixture.sources));
      assert.match(lines[1], /^ok \(/);
      assert.equal(lines.length, 2);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  for (const [name, problem] of [
    ['launch', 'positive leg: the second process did not attach to the first (pid 1)'],
    ['damagedPage', 'damaged-page leg: the untouched tree must still lead'],
  ]) {
    it(`a problem from the ${name} leg FAILS the gate — and the other leg still runs`, async () => {
      const fixture = gateFixtures();
      const { calls, legs } = recordingLegs({ [name]: [problem] });
      try {
        const { lines, problems } = await gate(fixture, { legs });
        assert.deepEqual(problems, [problem]);
        assert.deepEqual(calls.map(([leg]) => leg), ['launch', 'damagedPage']);
        // The size is printed whatever the verdict; "ok" is not.
        assert.deepEqual(lines, [sizeLine(fixture.sources)]);
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true });
      }
    });
  }

  it('a tree that is NOT what it says it is is never started', async () => {
    // A release bundle carrying a test hook: the sweep's problem, and no process.
    const fixture = gateFixtures(`${CLEAN} export const instructions = ${JSON.stringify(instructions)}; process.env.SNUG_MCP_TEST_BRAINS;`);
    const { calls, legs } = recordingLegs();
    try {
      const { lines, problems } = await gate(fixture, { legs });
      assert.ok(problems.some((p) => p.includes('SNUG_MCP_TEST_BRAINS')), JSON.stringify(problems));
      assert.deepEqual(calls, []);
      assert.deepEqual(lines, [sizeLine(fixture.sources)]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('checks the bundle against the instructions’ one source (D-B12) — a stale bundle is named and never started', async () => {
    const fixture = gateFixtures(`${CLEAN} export const instructions = "Call snug_status first.";`);
    const { calls, legs } = recordingLegs();
    try {
      const { problems } = await gate(fixture, { legs });
      assert.ok(problems.some((p) => /bundled instructions text differs/.test(p)), JSON.stringify(problems));
      assert.deepEqual(calls, []);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('holds the tree it built to the tree’s rules — one the directory would refuse is named and never started', async () => {
    // The mutant input: a page of exactly 5 MiB. Nothing about the BUNDLE is wrong, so only
    // the tree check — run over what the gate just built — can see it.
    const fixture = gateFixtures();
    writeFileSync(fixture.sources.kit, Buffer.alloc(MAX_FILE_BYTES, 0x20));
    const { calls, legs } = recordingLegs();
    try {
      const { problems } = await gate(fixture, { legs });
      assert.ok(problems.some((p) => /plugin directory would refuse/.test(p) && p.includes(PAGE_PATH)), JSON.stringify(problems));
      assert.deepEqual(calls, []);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('a validator’s refusal FAILS the gate; an absent validator is NOT VERIFIED by name, after the ok', async () => {
    const fixture = gateFixtures();
    const { legs } = recordingLegs();
    const seen = [];
    const verdicts = (list) => (dir) => {
      seen.push(dir);
      return list;
    };
    try {
      const refused = await gate(fixture, { legs, validators: verdicts([{ name: 'agentskills validate (skill)', status: 'failed', detail: 'description too long' }]) });
      assert.deepEqual(refused.problems, ['agentskills validate (skill) refused the tree:\ndescription too long']);
      assert.deepEqual(refused.lines, [sizeLine(fixture.sources)]);

      const absent = await gate(fixture, {
        legs,
        validators: verdicts([
          { name: 'claude plugin validate --strict (plugin)', status: 'ok', detail: '' },
          { name: 'agentskills validate (skill)', status: 'not verified', detail: 'uvx is not on this machine' },
        ]),
      });
      assert.deepEqual(absent.problems, []);
      assert.match(absent.lines[1], /^ok \(.*validators: claude plugin validate --strict \(plugin\) ok, agentskills validate \(skill\) not verified\)$/);
      assert.equal(absent.lines[2], 'NOT VERIFIED — agentskills validate (skill): uvx is not on this machine');
      // The validators are handed the tree the gate built.
      assert.deepEqual(seen, [fixture.out, fixture.out]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('a missing bundle is CANNOT RUN by name: nothing is built, nothing is started, no size is claimed', async () => {
    const fixture = gateFixtures();
    rmSync(fixture.sources.bundle);
    const { calls, legs } = recordingLegs();
    try {
      const { lines, problems } = await gate(fixture, { legs });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /^CANNOT RUN — .*snug-mcp\.mjs is missing \(pnpm --filter host-mcp build\)$/);
      assert.deepEqual(lines, []);
      assert.deepEqual(calls, []);
      assert.equal(existsSync(fixture.out), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('a missing build input is CANNOT RUN by name — after the bundle’s own problems, which are not lost with it', async () => {
    const fixture = gateFixtures(`${CLEAN} export const instructions = ${JSON.stringify(instructions)}; process.env.ANTHROPIC_API_KEY;`);
    rmSync(fixture.sources.kit);
    const { calls, legs } = recordingLegs();
    try {
      const { problems } = await gate(fixture, { legs });
      assert.equal(problems.length, 2, JSON.stringify(problems));
      assert.match(problems[0], /ANTHROPIC_API_KEY/);
      assert.match(problems[1], /^CANNOT RUN — missing kit/);
      assert.deepEqual(calls, []);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  describe('with no legs given, the legs are the REAL ones', () => {
    const outlived = [];
    afterEach(() => {
      assert.deepEqual(outlived.splice(0), [], 'the gate left a process running');
    });
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    it('the defaults are the launch legs and the damaged-page leg themselves', () => {
      assert.equal(GATE_LEGS.launch, runLaunchLegs);
      assert.equal(GATE_LEGS.damagedPage, runDamagedPageLeg);
      assert.ok(Object.isFrozen(GATE_LEGS));
    });

    it('runs them: a fixture tree whose "bundle" is an honest runner is started five times over, passes, and is reaped', async () => {
      // No fake leg here. The fixture's release bundle IS a runner — it leads, is joined,
      // refuses with no home, serves the page it ships and honours the page's pin — so the
      // whole gate runs as shipped: build → check → launch legs (3 processes) → damaged-page
      // leg (2). A gate whose default legs were swapped for no-ops starts nothing.
      const dir = mkdtempSync(path.join(tmpdir(), 'snug-gate-whole-'));
      const starts = path.join(dir, 'starts.log');
      const fixture = gateFixtures(`// a fixture release bundle: an honest runner, as the gate's legs see one
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
export const instructions = ${JSON.stringify(instructions)};
appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
const home = process.env.SNUG_HOME;
const pageFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', ${JSON.stringify(PAGE_PATH)});
const page = readFileSync(pageFile);
const damaged = readFileSync(pageFile + '.sha256', 'utf8').split(/\\s+/)[0] !== createHash('sha256').update(page).digest('hex');
let port = 0;
if (home !== undefined && !damaged) {
  const server = createServer((request, response) => response.end(page));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
}
const status = () => {
  if (home === undefined) return { running: false, refusal: { code: 'home-unresolved' } };
  if (damaged) return { running: false, refusal: { code: 'page-damaged' } };
  mkdirSync(home, { recursive: true });
  const record = path.join(home, 'primary.pid');
  const base = { running: true, port, home, file: path.join(home, 'user.snug') };
  if (existsSync(record)) return { ...base, attached: true, pid: Number(readFileSync(record, 'utf8')) };
  writeFileSync(record, String(process.pid));
  return { ...base, pid: process.pid };
};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snug', version: '0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'snug_status' }] });
  else reply(message.id, { content: [{ type: 'text', text: JSON.stringify(status()) }] });
});
process.stdin.on('end', () => process.exit(0));
`);
      const pids = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').map(Number) : []);
      try {
        const { lines, problems } = await gate(fixture);
        assert.deepEqual(problems, []);
        assert.match(lines[1], /^ok \(/);
        assert.equal(pids().length, 5, 'three processes for the launch legs, two for the damaged-page leg');
      } finally {
        outlived.push(...pids().filter(alive));
        rmSync(fixture.dir, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('the tests are RUN — a test file no script names tests nothing', () => {
  // Found 2026-10-03: `lib/skill-build.test.mjs` and `lib/plugin-launcher.test.mjs` had been in
  // no root script since the PR that added them (#181). Every rule of the skill render and of
  // the launcher had a mutant, and no gate had ever run one of them.
  const repo = new URL('..', import.meta.url);
  const scripts = JSON.parse(readFileSync(new URL('package.json', repo), 'utf8')).scripts;
  const testFiles = (dir) =>
    readdirSync(new URL(`${dir}/`, repo), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? testFiles(`${dir}/${entry.name}`) : /\.(test|node-test)\.mjs$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
    );

  it('every test file under scripts/ is named by a root script', () => {
    const named = Object.values(scripts).join(' ');
    const files = testFiles('scripts');
    assert.ok(files.length >= 20, `expected to find the scripts' test files, found ${files.length}`);
    assert.deepEqual(files.filter((file) => !named.split(/\s+/).includes(file)), []);
  });

  it('this gate runs the tests of everything it builds a plugin from', () => {
    const list = scripts['check-host-mcp'].split('&&')[0].trim().split(/\s+/);
    assert.deepEqual(list.slice(0, 2), ['node', '--test']);
    for (const file of ['scripts/check-host-mcp.test.mjs', 'scripts/build-plugin.test.mjs', 'scripts/lib/zip.test.mjs', 'scripts/lib/plugin-launcher.test.mjs', 'scripts/lib/skill-build.test.mjs', 'scripts/walk-desktop-host.test.mjs']) {
      assert.ok(list.includes(file), `check-host-mcp does not run ${file}`);
    }
    // …and the gate itself still follows them.
    assert.match(scripts['check-host-mcp'], /&& node scripts\/check-host-mcp\.mjs$/);
    assert.match(scripts.test, /pnpm run check-host-mcp/);
  });
});

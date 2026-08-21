// TASK-20260820 — one name for the user's file, everywhere (AC3, AC4, AC33, S4).
//
// THE BUG THIS FIXES WAS ALREADY SHIPPING. Before this change the same artifact left
// the product under two different names — `snug-user.snug` on desktop, `snug-user.sqlite`
// on web — and the web import picker's `accept` list did not include `.snug` at all.
// So a user who exported their file on the desktop app and then tried to import it in a
// browser found their own file GREYED OUT in the file chooser. Nothing failed loudly;
// it simply looked like the file was the wrong kind.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Relative to THIS file, not the cwd: vitest may be invoked from the repo root.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('the exported file has ONE name on every platform (AC3)', () => {
  it('does not branch the export filename on platform', () => {
    const settings = read('views/SettingsView.tsx');
    expect(settings).toContain("'snug-user.snug'");
    // The old platform split is what produced two names for one artifact.
    expect(settings).not.toContain("'snug-user.sqlite'");
    expect(settings).not.toMatch(/kind === 'desktop' \? 'snug-user/);
  });
});

describe('the import picker accepts what the product exports (AC4)', () => {
  it('lists .snug alongside the legacy .sqlite', () => {
    const accept = /accept="([^"]+)"/.exec(read('views/SettingsView.tsx'))?.[1] ?? '';
    expect(accept).toContain('.snug');
    // The legacy extension stays listed: users have real `.sqlite` exports and backups
    // from before the rename, and refusing them would strand exactly the people the
    // adopt-forward path exists to protect.
    expect(accept).toContain('.sqlite');
  });
});

describe('a per-app export is named .snug too (AC5)', () => {
  it('uses the canonical extension', () => {
    expect(read('run/RunView.tsx')).toContain(".snug`");
  });

  it('the user-facing export surface says snug, never the legacy sqlite', () => {
    // MIGRATED (TASK-20260821-hardening-polish): the per-app header control is hidden
    // behind SHOW_APP_EXPORT, so the Settings whole-file export is the surface a user
    // actually sees — its control copy and its download name carry this claim now.
    const settings = read('views/SettingsView.tsx');
    expect(settings).toContain('export snug file');
    expect(settings).toContain("'snug-user.snug'");
    expect(settings).not.toContain('export .sqlite');
    // The dormant header path keeps its established name, so re-enabling the one flag
    // cannot resurrect the old two-names bug.
    const header = read('run/RunHeaderActions.tsx');
    expect(header).toContain('export .snug');
    expect(header).not.toContain('export .sqlite');
  });
});

describe('the export MIME follows the bytes (S4)', () => {
  it('does not claim a protected export is an openable SQLite database', () => {
    const sync = read('state/sync.ts');
    // Labelling a container `application/x-sqlite3` would tell every tool on the
    // machine it can be opened as a database, which it cannot.
    expect(sync).toMatch(/seal === undefined \? 'application\/x-sqlite3' : 'application\/octet-stream'/);
  });
});

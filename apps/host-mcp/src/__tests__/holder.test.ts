// D-B10 — the holder signal.

import { describe, expect, it } from 'vitest';

import { detectHolder } from '../holder.js';

const table = (...lines: string[]) => () => `COMMAND\n${lines.join('\n')}\n`;

describe('detectHolder', () => {
  it('names Snug for Mac when the desktop binary is running', () => {
    expect(detectHolder({ processList: table('/Applications/Snug.app/Contents/MacOS/snug-desktop', 'node') })).toBe('Snug for Mac');
  });

  it('reports nothing when it is not', () => {
    expect(detectHolder({ processList: table('node', 'Finder', 'com.apple.WebKit') })).toBeUndefined();
  });

  it('does not match a longer name that merely CONTAINS the binary name', () => {
    // A folder or app called `snug-desktop-notes` is not the desktop; matching a substring
    // would refuse to open the runner for a user who has never installed it.
    expect(detectHolder({ processList: table('/Users/x/snug-desktop-notes', 'snug-desktop-helper') })).toBeUndefined();
  });

  it('treats an unreadable process table as "not held" rather than stranding the user', () => {
    // The 423 on write is the backstop if this guessed wrong; refusing to open on a failed
    // probe would make an unrelated OS hiccup look like a Snug fault.
    expect(detectHolder({ processList: () => { throw new Error('no ps'); } })).toBeUndefined();
  });
});

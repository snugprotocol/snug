// Storage rules for the BYOK credential (task AC-5): sessionStorage only, ever.

import { beforeEach, describe, expect, it } from 'vitest';

import { BYOK_KEY_STORAGE_KEY, getByokKey, setByokKey, setMode, modeStore } from '../state/mode.js';

describe('byok key storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('stores the key in sessionStorage and NEVER in localStorage', () => {
    setByokKey('sk-ant-test-123');
    expect(sessionStorage.getItem(BYOK_KEY_STORAGE_KEY)).toBe('sk-ant-test-123');
    // The whole of localStorage must be key-free — not just the known slot.
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i) as string;
      expect(localStorage.getItem(name)).not.toContain('sk-ant-test-123');
    }
    expect(localStorage.getItem(BYOK_KEY_STORAGE_KEY)).toBeNull();
  });

  it('round-trips through getByokKey and trims whitespace', () => {
    setByokKey('  sk-test  ');
    expect(getByokKey()).toBe('sk-test');
  });

  it('clears the key when set to empty', () => {
    setByokKey('sk-test');
    setByokKey('   ');
    expect(getByokKey()).toBeUndefined();
    expect(sessionStorage.getItem(BYOK_KEY_STORAGE_KEY)).toBeNull();
  });
});

describe('mode store', () => {
  it('persists the mode choice to localStorage', () => {
    setMode('byok');
    expect(localStorage.getItem('snug:mode')).toBe('byok');
    expect(modeStore.get()).toBe('byok');
    setMode('server');
    expect(localStorage.getItem('snug:mode')).toBe('server');
  });
});

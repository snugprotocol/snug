// AL-07 AC1/AC3: the webllm brain DECISION — tested at the altitude where the
// condition is evaluated (lessons 2026-08-05), not at its downstream effects. The
// resolver is the single line that decides settings vs webllm vs demo-fallback;
// every consumer (builder chat, app-frame transport, banner, settings card) reads it.

import { describe, expect, it } from 'vitest';

import { WEBLLM_DEFAULT_MODEL } from '../agent/webllm/model.js';
import {
  detectWebGpu,
  initWebllm,
  parseWebllmFlag,
  resolveBrain,
  WEBLLM_FALLBACK_BANNER,
  webgpuStore,
  webllmFlagStore,
} from '../state/webllm.js';

describe('parseWebllmFlag', () => {
  it('is on only for ?webllm=1 (exact value), anywhere in the query', () => {
    expect(parseWebllmFlag('?webllm=1')).toBe(true);
    expect(parseWebllmFlag('?foo=bar&webllm=1')).toBe(true);
    expect(parseWebllmFlag('')).toBe(false);
    expect(parseWebllmFlag('?')).toBe(false);
    expect(parseWebllmFlag('?webllm=0')).toBe(false);
    expect(parseWebllmFlag('?webllm=true')).toBe(false);
    expect(parseWebllmFlag('?webllm')).toBe(false);
    expect(parseWebllmFlag('?notwebllm=1')).toBe(false);
  });
});

describe('resolveBrain (AC1/AC2/AC3 decision table)', () => {
  it('flag off ⇒ settings brain for EVERY webgpu state (AC1: flag-off is invisible)', () => {
    expect(resolveBrain(false, 'unknown')).toEqual({ kind: 'settings' });
    expect(resolveBrain(false, 'yes')).toEqual({ kind: 'settings' });
    expect(resolveBrain(false, 'no')).toEqual({ kind: 'settings' });
  });

  it('flag on + WebGPU ⇒ webllm brain carrying the DEFAULT model id (AC2; model per ADR-0015)', () => {
    expect(resolveBrain(true, 'yes')).toEqual({ kind: 'webllm', model: WEBLLM_DEFAULT_MODEL });
  });

  it('flag on + no WebGPU ⇒ demo fallback with the no-webgpu reason (AC3)', () => {
    expect(resolveBrain(true, 'no')).toEqual({ kind: 'demo', reason: 'no-webgpu' });
  });

  it('flag on + probe not finished ⇒ demo fallback with the probing reason (never webllm before the probe)', () => {
    expect(resolveBrain(true, 'unknown')).toEqual({ kind: 'demo', reason: 'probing' });
  });
});

describe('detectWebGpu', () => {
  it('true when the adapter probe answers', async () => {
    expect(await detectWebGpu({ requestAdapter: () => Promise.resolve({}) })).toBe(true);
  });

  it('false when navigator.gpu is missing entirely', async () => {
    expect(await detectWebGpu(undefined)).toBe(false);
  });

  it('false when requestAdapter answers null (gpu object present but no adapter)', async () => {
    expect(await detectWebGpu({ requestAdapter: () => Promise.resolve(null) })).toBe(false);
  });

  it('false when the probe throws — detection failure is absence, never a crash', async () => {
    expect(await detectWebGpu({ requestAdapter: () => Promise.reject(new Error('boom')) })).toBe(false);
  });
});

describe('initWebllm (boot wiring)', () => {
  it('flag off: stores record off + unknown and the gpu probe is never run', async () => {
    webllmFlagStore.set(true);
    webgpuStore.set('yes');
    let probed = false;
    await initWebllm({
      search: '',
      gpu: {
        requestAdapter: () => {
          probed = true;
          return Promise.resolve({});
        },
      },
    });
    expect(webllmFlagStore.get()).toBe(false);
    expect(webgpuStore.get()).toBe('unknown');
    expect(probed).toBe(false);
  });

  it('flag on + adapter ⇒ webgpu yes', async () => {
    await initWebllm({ search: '?webllm=1', gpu: { requestAdapter: () => Promise.resolve({}) } });
    expect(webllmFlagStore.get()).toBe(true);
    expect(webgpuStore.get()).toBe('yes');
  });

  it('flag on + no adapter ⇒ webgpu no', async () => {
    await initWebllm({ search: '?webllm=1', gpu: undefined });
    expect(webllmFlagStore.get()).toBe(true);
    expect(webgpuStore.get()).toBe('no');
  });
});

describe('banner copy (pinned literal)', () => {
  it('matches the task-file contract verbatim', () => {
    expect(WEBLLM_FALLBACK_BANNER).toBe('this browser can’t run local models — showing the demo brain');
  });
});

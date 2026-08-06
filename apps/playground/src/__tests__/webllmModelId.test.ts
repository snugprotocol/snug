// AL-07 guard: the default model id must exist in the PINNED @mlc-ai/web-llm
// version's prebuilt list — the id names weights + a model library compiled for that
// exact runtime version, so a dep bump (or a typo) that orphans it would fail only at
// user runtime, after a multi-GB download attempt. This is the one test that imports
// the real lib (types/config only — no engine is created, nothing downloads).

import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { describe, expect, it } from 'vitest';

import { WEBLLM_DEFAULT_MODEL } from '../agent/webllm/model.js';

describe('WEBLLM_DEFAULT_MODEL', () => {
  it('is a model_id shipped by the pinned web-llm version', () => {
    const ids = prebuiltAppConfig.model_list.map((entry) => entry.model_id);
    expect(ids).toContain(WEBLLM_DEFAULT_MODEL);
  });

  it('stays in the small-model range the spike targets (< 4 GB VRAM)', () => {
    const entry = prebuiltAppConfig.model_list.find((candidate) => candidate.model_id === WEBLLM_DEFAULT_MODEL);
    expect(entry?.vram_required_MB).toBeLessThan(4000);
  });
});

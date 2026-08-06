// model.ts — the webllm default model id (a LEAF module: imported by both the state
// layer and the engine, so it must import nothing).
//
// Decided by ADR-0015 (TASK-20260806-webllm-spike, umbrella Phase-0 decision 3): the
// spike ships ONE pinned default from @mlc-ai/web-llm@0.2.84's prebuilt list — the
// model picker is GA scope (roadmap 1.2-1). The id doubles as the wire model name the
// engine reports back, so the inspector shows exactly what ran.
//
// NOTE: this must be a `model_id` present in the PINNED web-llm version's
// `prebuiltAppConfig.model_list` — bumping the dep can invalidate it; the guard test
// in webllmModelId.test.ts pins that relationship.
export const WEBLLM_DEFAULT_MODEL = 'Qwen3-1.7B-q4f16_1-MLC';

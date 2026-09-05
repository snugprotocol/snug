// The kit's `@mlc-ai/web-llm` (TASK-20260905-host-kit P5): the playground's engine module
// `import()`s the real package lazily, and a single-file build (`inlineDynamicImports`)
// would inline the 6 MB engine. The kit pins its brain through the platform seat, so the
// webllm arm is unreachable — this stub keeps the bytes out and names the fact if it is
// ever reached.

export async function CreateMLCEngine(): Promise<never> {
  throw new Error('WebLLM is not part of the host kit — the brain is pinned by the host (TASK-20260905-host-kit D15)');
}

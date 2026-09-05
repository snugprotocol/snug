// artifact-helpers.ts — fakes of the two Claude artifact runtimes, installed BEFORE the
// page's script runs (`addInitScript`), so the BUILT kit page boots as it would inside a
// viewer (TASK-20260905-binding-a-artifacts AC1/AC2/AC5/AC6/AC8/AC10/AC12). Every fake
// RECORDS what the page did — calls, inputs, options, published html, saved files — on
// `window.__snugFake`, which the specs read back. Nothing here is the real runtime: the
// real hosted walk is the owner's (AC13), and it is journaled with the artifact URL.
import type { Page } from '@playwright/test';

export interface HostedFakeOptions {
  /** What `sample` answers — the chess reply on `quick` is fenced, like the platform (T1 S3). */
  reply?: string;
  /** `artifact.publish` outcome: a version, or a rejection code. */
  publish?: { version: string } | { reject: string };
  /** Resolve `artifact` / `downloads` / `sample` to null (a static top-level page resolves all three null). */
  nulls?: ('sample' | 'artifact' | 'downloads')[];
}

export interface FakeRecord {
  sampleCalls: { input: unknown; options: Record<string, unknown> }[];
  published: string[];
  saved: { filename: string; data: string }[];
  completeCalls: string[];
  storage: Record<string, string>;
}

const DEFAULT_REPLY = '```json\n{"move":{"from":"e7","to":"e5"},"message":"the fake viewer answers"}\n```';

/** The hosted runtime: `window.claude.use(name)` — use-only, resolves per name. */
export async function installHostedFake(page: Page, options: HostedFakeOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ reply, publish, nulls }) => {
      const record = { sampleCalls: [], published: [], saved: [], completeCalls: [], storage: {} } as unknown as FakeRecord;
      (window as unknown as { __snugFake: FakeRecord }).__snugFake = record;
      const sample = Object.assign(
        async (input: unknown, opts: Record<string, unknown> = {}) => {
          record.sampleCalls.push({ input, options: { ...opts, onText: opts.onText === undefined ? undefined : 'fn', signal: opts.signal === undefined ? undefined : 'signal' } });
          const onText = opts.onText as ((e: { text: string; delta: string }) => void) | undefined;
          const half = reply.slice(0, Math.floor(reply.length / 2));
          onText?.({ text: half, delta: half });
          onText?.({ text: reply, delta: reply.slice(half.length) });
          return { text: reply, truncated: false, modelTierApplied: (opts.modelTier as string) ?? 'default' };
        },
        { limits: async () => ({ maxPromptBytes: 65536 }), json: async () => JSON.parse(reply.replace(/```json\n|\n```/g, '')) },
      );
      const artifact = {
        publish: async (html: string) => {
          if ('reject' in publish) throw Object.assign(new Error(publish.reject), { code: publish.reject });
          record.published.push(html);
          return { version: publish.version };
        },
      };
      const downloads = {
        save: async (request: { filename: string; data: unknown }) => {
          record.saved.push({ filename: request.filename, data: typeof request.data === 'string' ? request.data : '[binary]' });
          return {};
        },
      };
      const table: Record<string, unknown> = { sample, artifact, downloads };
      for (const name of nulls) table[name] = null;
      (window as unknown as { claude: unknown }).claude = { use: async (name: string) => table[name] ?? null };
    },
    { reply: options.reply ?? DEFAULT_REPLY, publish: options.publish ?? { version: 'v-fake' }, nulls: options.nulls ?? [] },
  );
}

/** The chat runtime: a flat `window.claude.complete` and `window.storage` (T1 S2/S10 shapes). */
export async function installChatFake(page: Page, reply = DEFAULT_REPLY): Promise<void> {
  await page.addInitScript((replyText) => {
    const record = { sampleCalls: [], published: [], saved: [], completeCalls: [], storage: {} } as unknown as FakeRecord;
    (window as unknown as { __snugFake: FakeRecord }).__snugFake = record;
    (window as unknown as { claude: unknown }).claude = {
      complete: async (prompt: string) => {
        record.completeCalls.push(prompt);
        return replyText;
      },
    };
    // The real `window.storage` PERSISTS across reloads (T1 S10); an init script runs afresh
    // on every navigation, so the fake keeps its rows in the page's localStorage.
    const PREFIX = 'snug-fake-window-storage:';
    const keys = (): string[] => Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
    const snapshot = (): void => {
      for (const k of keys()) record.storage[k] = localStorage.getItem(PREFIX + k) ?? '';
    };
    snapshot();
    (window as unknown as { storage: unknown }).storage = {
      get: async (key: string) => {
        const value = localStorage.getItem(PREFIX + key);
        if (value === null) throw new Error('Storage get failed: Unexpected response type');
        return { key, value };
      },
      set: async (key: string, value: string) => {
        localStorage.setItem(PREFIX + key, value);
        snapshot();
        return { key, value };
      },
      delete: async (key: string) => {
        localStorage.removeItem(PREFIX + key);
        delete record.storage[key];
        return { key };
      },
      list: async (prefix?: string) => ({ keys: keys().filter((k) => prefix === undefined || k.startsWith(prefix)), prefix: prefix ?? '', shared: false }),
    };
  }, reply);
}

export async function fakeRecord(page: Page): Promise<FakeRecord> {
  return page.evaluate(() => (window as unknown as { __snugFake: FakeRecord }).__snugFake);
}

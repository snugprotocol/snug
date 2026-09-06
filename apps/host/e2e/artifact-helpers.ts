// artifact-helpers.ts — fakes of the two Claude artifact runtimes, installed BEFORE the
// page's script runs (`addInitScript`), so the BUILT kit page boots as it would inside a
// viewer (TASK-20260905-binding-a-artifacts AC1/AC2/AC5/AC6/AC8/AC10/AC12). Every fake
// RECORDS what the page did — calls, inputs, options, published html, saved files — on
// `window.__snugFake`, which the specs read back. Nothing here is the real runtime: the
// real hosted walk is the owner's (AC13), and it is journaled with the artifact URL.
//
// Two fidelities the Gate-5 review asked for: the fakes install in the TOP frame only (a
// viewer never hands the app iframe a `window.claude`; an init script would otherwise run
// in every frame), and `use` / `complete` are this-dependent (the real runtime throws
// "Illegal invocation" when called detached — the kit must call them as methods).
import type { Page } from '@playwright/test';

export interface HostedFakeOptions {
  /**
   * What `sample` answers — the chess reply on `quick` is fenced, like the platform (T1 S3).
   * `{ templateFromPrompt: true }` (TASK-20260906-tool-free-kb-inlining AC5): the fake reads
   * the prompt it RECEIVED, lifts the first ```html fence after "## Full Template", and answers
   * with that document fenced — no fixture template, so a prompt that stopped carrying the
   * template answers with the marker below and the build lands nothing.
   */
  reply?: string | { templateFromPrompt: true };
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
      if (window !== window.top) return; // top frame only
      const record = { sampleCalls: [], published: [], saved: [], completeCalls: [], storage: {} } as unknown as FakeRecord;
      (window as unknown as { __snugFake: FakeRecord }).__snugFake = record;
      const NO_TEMPLATE = 'the prompt carried no "## Full Template" fence — the fake viewer has nothing to copy';
      /**
       * The reply for one call: the scripted string, or the template lifted from the prompt
       * itself. The lift follows the template's OWN rule for its section 5 ("copy exactly
       * when the app calls an approved API; omit otherwise"): the app calls none, so the
       * section goes — its mere presence would mark the build as connected and send the
       * post-turn recovery inferrer after the first URL in the file (the CDN).
       */
      const replyFor = (input: unknown): string => {
        if (typeof reply === 'string') return reply;
        const prompt = typeof input === 'string' ? input : (input as { content: string }[]).map((t) => t.content).join('\n');
        const at = prompt.indexOf('## Full Template');
        const fence = at < 0 ? null : /```html\n([\s\S]*?)```/.exec(prompt.slice(at));
        if (fence === null) return NO_TEMPLATE;
        // The section is located by its banner + the hook's own name, never by its number
        // (the template has been renumbered before), and a miss THROWS so a drift fails at
        // the cause instead of as "expected 3 sample calls to be 2" three files away.
        const section = /\n *\/\/ =+\n *\/\/ \d+\. useConnectedFetch[\s\S]*?function useConnectedFetch\(\)[\s\S]*?(?=\n *\/\/ =+\n *\/\/ \d+\. )/.exec(fence[1]!);
        if (section === null) throw new Error('templateFromPrompt: the useConnectedFetch section was not found in the lifted template — the template\'s structure moved');
        const doc = fence[1]!.replace(section[0], '');
        if (/useConnectedFetch/.test(doc)) throw new Error('templateFromPrompt: useConnectedFetch survived the strip');
        return `Here is your app.\n\n\`\`\`html\n${doc}\`\`\``;
      };
      const sample = Object.assign(
        async (input: unknown, opts: Record<string, unknown> = {}) => {
          record.sampleCalls.push({ input, options: { ...opts, onText: opts.onText === undefined ? undefined : 'fn', signal: opts.signal === undefined ? undefined : 'signal' } });
          const text = replyFor(input);
          const onText = opts.onText as ((e: { text: string; delta: string }) => void) | undefined;
          const half = text.slice(0, Math.floor(text.length / 2));
          onText?.({ text: half, delta: half });
          onText?.({ text, delta: text.slice(half.length) });
          return { text, truncated: false, modelTierApplied: (opts.modelTier as string) ?? 'default' };
        },
        { limits: async () => ({ maxPromptBytes: 65536 }), json: async (input: unknown) => JSON.parse(replyFor(input).replace(/```json\n|\n```/g, '')) },
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
      const claude = {
        use(this: unknown, name: string): Promise<unknown> {
          if (this !== claude) return Promise.reject(new TypeError('Illegal invocation'));
          return Promise.resolve(table[name] ?? null);
        },
      };
      (window as unknown as { claude: unknown }).claude = claude;
    },
    { reply: options.reply ?? DEFAULT_REPLY, publish: options.publish ?? { version: 'v-fake' }, nulls: options.nulls ?? [] },
  );
}

/** The chat runtime: a flat `window.claude.complete` and `window.storage` (T1 S2/S10 shapes). */
export async function installChatFake(page: Page, reply = DEFAULT_REPLY): Promise<void> {
  await page.addInitScript((replyText) => {
    if (window !== window.top) return; // top frame only
    const record = { sampleCalls: [], published: [], saved: [], completeCalls: [], storage: {} } as unknown as FakeRecord;
    (window as unknown as { __snugFake: FakeRecord }).__snugFake = record;
    const claude = {
      complete(this: unknown, prompt: string): Promise<string> {
        if (this !== claude) return Promise.reject(new TypeError('Illegal invocation'));
        record.completeCalls.push(prompt);
        return Promise.resolve(replyText);
      },
    };
    (window as unknown as { claude: unknown }).claude = claude;
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

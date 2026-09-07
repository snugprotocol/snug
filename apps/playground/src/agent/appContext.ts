// appContext.ts — the app-attached turn context (child 3, umbrella AC4). Every chat
// surface bound to an app feeds the LLM the app's identity, registered schema, wiki
// docs, current code, and recent thread history — so "add a fee column to trades"
// actually means something. Used identically by both paths: direct mode appends the
// block to the system prompt and sends history as real turns; subscription mode
// prepends the block to the wire message (the hub server stays unchanged).
//
// Every section is byte-capped with an explicit truncation marker (review F-list:
// context bloat is bounded, never silent).

import type { UserDb } from '@snugprotocol/db';

export const CONTEXT_CAPS = {
  /** Current app HTML — the biggest section, capped hardest. */
  html: 140_000,
  /** Registered schema DDL. */
  schema: 10_000,
  /** All wiki docs combined. */
  docs: 20_000,
  /** Persisted thread history replayed as turns (direct mode). */
  history: 10_000,
} as const;

export const TRUNCATION_MARKER = '\n…[truncated to fit the context budget]';

export interface TurnHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AppTurnContext {
  /** Markdown block describing the attached app; absent when there is nothing to attach. */
  contextBlock?: string;
  /** Persisted prior turns (newest retained within the cap), chronological order. */
  history: TurnHistoryMessage[];
}

function capText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}${TRUNCATION_MARKER}`;
}

/**
 * Build the turn context for a chat surface. `appId` undefined (or an app with no
 * row, schema, or docs) yields history only — a fresh builder thread has nothing to
 * attach yet.
 */
export async function buildAppTurnContext(
  db: UserDb,
  appId: string | undefined,
  threadId: string,
  /**
   * Per-call caps (TASK-20260905-binding-a-artifacts AC3): the host kit passes
   * `HOST_CONTEXT_CAPS` (html unbounded — it rides whole or the builder refuses; the rest
   * shrunk under 64 KiB). Absent or partial → the defaults, byte for byte.
   */
  capsOverride?: Partial<Record<keyof typeof CONTEXT_CAPS, number>>,
  /**
   * TASK-20260906 (ADR-0066, Gate-5 fold): the block's two "use the tool" sentences have a
   * tool-free wording for a brain that has none (the pinned host brain, webllm) — an edit
   * turn under such a brain was still told to "write the file via the artifact write tool".
   */
  options: { toolFree?: boolean } = {},
): Promise<AppTurnContext> {
  const caps: Record<keyof typeof CONTEXT_CAPS, number> = { ...CONTEXT_CAPS, ...capsOverride };
  const history: TurnHistoryMessage[] = [];
  const persisted = db.listChatMessages(threadId).filter((m) => m.role === 'user' || m.role === 'assistant');
  let used = 0;
  for (let i = persisted.length - 1; i >= 0; i--) {
    const message = persisted[i]!;
    if (used + message.content.length > caps.history) break;
    used += message.content.length;
    history.unshift({ role: message.role === 'user' ? 'user' : 'assistant', content: message.content });
  }

  if (appId === undefined) return { history };
  const app = db.getApp(appId);
  const schema = db.getAppSchema(appId);
  const docs = db.listAppDocs(appId);
  if (app === undefined && schema === undefined && docs.length === 0) return { history };

  const parts: string[] = ['## The app you are working on'];
  if (app !== undefined) {
    const line = [
      `Name: ${app.displayName}`,
      ...(app.description !== undefined ? [`Description: ${app.description}`] : []),
      `Current version: v${app.currentVersion}`,
    ].join('\n');
    parts.push(line);
  }

  parts.push(
    '### Registered data schema',
    schema !== undefined && schema.objects.length > 0
      ? capText(schema.objects.map((o) => o.ddl).join(';\n'), caps.schema)
      : options.toolFree === true
        ? "(none registered — create the app's tables in its own startup DDL, as the persistence rules describe)"
        : '(none registered yet — design one with the schema tool before writing data-backed code)',
  );

  if (docs.length > 0) {
    const rendered = docs.map((doc) => `#### ${doc.title ?? doc.slug}\n${doc.content}`).join('\n\n');
    parts.push('### App knowledge docs', capText(rendered, caps.docs));
  }

  const html = app !== undefined ? db.getAppHtml(appId) : undefined;
  if (html !== undefined) {
    parts.push(
      `### Current app code (v${app!.currentVersion})`,
      '```html\n' + capText(html, caps.html) + '\n```',
      options.toolFree === true
        ? 'When changing the app, reply with the ENTIRE updated file as one complete HTML document — it lands as the next version of THIS app.'
        : 'When changing the app, write the ENTIRE updated file via the artifact write tool — it lands as the next version of THIS app.',
    );
  }

  return { contextBlock: parts.join('\n\n'), history };
}

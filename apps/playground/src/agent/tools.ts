// tools.ts — the direct-mode chat-path tool set: the browser-side twin of the server's
// buildServerTools. Tool names/descriptions come from the knowledge store (ADR-0004);
// artifact_write flows through an ArtifactSink into the USER DB — the sink pins the
// target app host-side (F9), so a write is an install or a new version, never a
// model-chosen destination.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import {
  APP_BUILDER_TOOL_NAME,
  APP_DOC_WRITE_TOOL_NAME,
  ARTIFACT_EDIT_TOOL_NAME,
  RUNTIME_CONTRACT_WRITE_TOOL_NAME,
  SCHEMA_APPLY_TOOL_NAME,
  getToolPrompt,
  searchKnowledge,
} from '@snugprotocol/knowledge';
import { runtimeContractSchema } from '@snugprotocol/protocol';

import { getUserDb } from '../state/userdb.js';
import type { ArtifactSink, ArtifactWriteResult } from './artifactSink.js';

export const ARTIFACT_WRITE_TOOL_NAME = 'artifact_write';

/** Doc slugs are ids, not prose: lowercase, hyphen-separated (matches the standard slugs). */
const DOC_SLUG_RULE = /^[a-z][a-z0-9-]{0,40}$/;

export interface ByokToolHooks {
  onArtifact: (artifact: ArtifactWriteResult) => void;
  /** UI refresh signals for the app's schema/docs panels (child 3). */
  onSchemaApplied?: (appId: string) => void;
  onDocWritten?: (appId: string, slug: string) => void;
  /** The app's runtime contract was authored/replaced (ADR-0018). */
  onRuntimeContractWritten?: (appId: string) => void;
}

export interface BuildByokToolsOptions {
  /** Injectable for tests; defaults to the page user DB. */
  getDb?: () => Promise<UserDb>;
}

export function buildByokTools(
  sink: ArtifactSink,
  hooks: ByokToolHooks,
  options: BuildByokToolsOptions = {},
): AgentTool[] {
  const getDb = options.getDb ?? getUserDb;
  return [
    {
      def: {
        name: APP_BUILDER_TOOL_NAME,
        description: getToolPrompt('app-builder'),
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
      run: (input) => {
        const query = typeof input.query === 'string' ? input.query : '';
        const results = searchKnowledge(query);
        return results
          .map((result) => `[${result.file}${result.heading === '' ? '' : ` — ${result.heading}`}]\n${result.text}`)
          .join('\n\n---\n\n');
      },
    },
    {
      def: {
        name: ARTIFACT_WRITE_TOOL_NAME,
        description: getToolPrompt('artifact-write'),
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string' }, title: { type: 'string' } },
          required: ['content'],
        },
      },
      run: async (input) => {
        if (typeof input.content !== 'string' || input.content === '') {
          return 'Error: "content" must be a non-empty string containing the entire file body.';
        }
        const title = typeof input.title === 'string' ? input.title : undefined;
        const artifact = await sink.write(input.content, title);
        hooks.onArtifact(artifact);
        return artifact.version === 1
          ? `Created "${artifact.displayName}" at /artifacts/${artifact.id}`
          : `Updated "${artifact.displayName}" (version ${artifact.version}) at /artifacts/${artifact.id}`;
      },
    },
    {
      def: {
        name: ARTIFACT_EDIT_TOOL_NAME,
        description: getToolPrompt('artifact-edit'),
        inputSchema: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: { oldString: { type: 'string' }, newString: { type: 'string' } },
                required: ['oldString', 'newString'],
              },
            },
          },
          required: ['edits'],
        },
      },
      run: async (input) => {
        const raw = Array.isArray(input.edits) ? input.edits : undefined;
        if (raw === undefined || raw.length === 0) {
          return 'Error: "edits" must be a non-empty array of {oldString, newString} objects.';
        }
        const edits: Array<{ oldString: string; newString: string }> = [];
        for (const entry of raw) {
          if (typeof entry !== 'object' || entry === null) return 'Error: each edit must be an object.';
          const { oldString, newString } = entry as Record<string, unknown>;
          if (typeof oldString !== 'string' || oldString === '') {
            return 'Error: each edit needs a non-empty "oldString" copied verbatim from the file.';
          }
          if (typeof newString !== 'string') return 'Error: each edit needs a string "newString".';
          edits.push({ oldString, newString });
        }

        const db = await getDb();
        const appId = await sink.ensureTargetId();
        const current = db.getApp(appId) === undefined ? undefined : db.getAppHtml(appId);
        if (current === undefined) {
          return 'Error: this app has no file to edit yet — write the whole file first.';
        }

        /**
         * UNIQUE-MATCH-OR-FAIL, applied to a WORKING COPY.
         *
         * Uniqueness is re-checked against the text as it stands after each earlier edit,
         * because applying edits in sequence can CREATE an ambiguity that did not exist in
         * the original. Nothing is persisted until every edit has succeeded — a
         * half-applied batch would be worse than a refused one.
         */
        let next = current;
        for (const [index, edit] of edits.entries()) {
          const occurrences = next.split(edit.oldString).length - 1;
          if (occurrences === 0) {
            return `Error: edit ${index + 1} did not match — "${edit.oldString.slice(0, 60)}" is not in the file. Nothing was changed.`;
          }
          if (occurrences > 1) {
            return `Error: edit ${index + 1} is ambiguous — "${edit.oldString.slice(0, 60)}" appears ${occurrences} times. Include more surrounding text so it matches exactly once. Nothing was changed.`;
          }
          next = next.replace(edit.oldString, edit.newString);
        }

        // The SAME sink path artifact_write uses, so the result is a version like any
        // other: same pinning, same reload, same contract copy-forward.
        const artifact = await sink.write(next);
        hooks.onArtifact(artifact);
        return `Applied ${edits.length} edit(s) — "${artifact.displayName}" is now version ${artifact.version}.`;
      },
    },
    {
      def: {
        name: SCHEMA_APPLY_TOOL_NAME,
        description: getToolPrompt('schema-apply'),
        inputSchema: {
          type: 'object',
          properties: { statements: { type: 'array', items: { type: 'string' } } },
          required: ['statements'],
        },
      },
      run: async (input) => {
        const statements = Array.isArray(input.statements)
          ? input.statements.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          : [];
        if (statements.length === 0) {
          return 'Error: "statements" must be a non-empty array of complete SQL statements.';
        }
        const db = await getDb();
        const appId = await sink.ensureTargetId();
        try {
          const schema = await db.applyAppDdl(appId, statements);
          hooks.onSchemaApplied?.(appId);
          const names = schema.objects.map((o) => o.name).join(', ');
          return `Applied ${statements.length} statement(s). The app's registered schema now has ${schema.objects.length} object(s): ${names}.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      def: {
        name: APP_DOC_WRITE_TOOL_NAME,
        description: getToolPrompt('app-doc-write'),
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['slug', 'content'],
        },
      },
      run: async (input) => {
        const slug = typeof input.slug === 'string' ? input.slug : '';
        if (!DOC_SLUG_RULE.test(slug)) {
          return `Error: "slug" must match ${DOC_SLUG_RULE.source} (lowercase, hyphen-separated).`;
        }
        if (typeof input.content !== 'string' || input.content.trim() === '') {
          return 'Error: "content" must be the complete non-empty markdown body of the page.';
        }
        const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title : undefined;
        const db = await getDb();
        const appId = await sink.ensureTargetId();
        try {
          db.putAppDoc(appId, slug, { content: input.content, ...(title !== undefined ? { title } : {}) });
          hooks.onDocWritten?.(appId, slug);
          return `Updated app doc "${slug}".`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      def: {
        name: RUNTIME_CONTRACT_WRITE_TOOL_NAME,
        description: getToolPrompt('runtime-contract-write'),
        inputSchema: {
          type: 'object',
          properties: {
            overview: { type: 'string' },
            personaNote: { type: 'string' },
            stateGuidance: { type: 'string' },
            responseGuidance: { type: 'string' },
            settings: { type: 'object' },
            maxOutputTokens: { type: 'number' },
          },
          required: ['overview'],
        },
      },
      run: async (input) => {
        // The REAL schema does the validating (bounds-at-parse, ADR-0018 D2) — the
        // JSON-Schema above only shapes the tool list the model sees. Re-implementing the
        // bounds here would give the contract two definitions that could disagree.
        const parsed = runtimeContractSchema.safeParse(input);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          return `Error: the runtime contract was rejected — ${issues}`;
        }
        const db = await getDb();
        const appId = await sink.ensureTargetId();
        // A contract belongs to a VERSION row. Before the first artifact write the sink
        // has pre-minted an id but no app exists, so there is nothing to attach to —
        // saying so beats writing a contract that would be silently lost (AC-F1-2).
        const app = db.getApp(appId);
        if (app === undefined) {
          return 'Error: write the app artifact first — a runtime contract attaches to an app version, and this app has none yet.';
        }
        try {
          db.putRuntimeContract(appId, app.currentVersion, parsed.data);
          hooks.onRuntimeContractWritten?.(appId);
          return `Recorded the runtime contract for v${app.currentVersion}. Its own turns will now be assembled from this, not from the build conversation.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];
}

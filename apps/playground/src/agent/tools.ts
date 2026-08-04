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
  SCHEMA_APPLY_TOOL_NAME,
  getToolPrompt,
  searchKnowledge,
} from '@snugprotocol/knowledge';

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
  ];
}

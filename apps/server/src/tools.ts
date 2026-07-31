// tools.ts — the chat-path tool set. Tool names and descriptions come from the
// knowledge store (ADR-0004: no prompt literals in server code): the app-builder name
// is APP_BUILDER_TOOL_NAME and both descriptions are getToolPrompt() renders.

import type { AgentTool } from '@snugprotocol/adapters';
import { APP_BUILDER_TOOL_NAME, getToolPrompt, searchKnowledge } from '@snugprotocol/knowledge';

import type { ArtifactMeta, ArtifactStore } from './stores/artifacts.js';

/** Wire identifier of the artifact tool (an identifier, not prompt text). */
export const ARTIFACT_WRITE_TOOL_NAME = 'artifact_write';

export function artifactUrl(id: string): string {
  return `/artifacts/${id}`;
}

export interface ServerToolHooks {
  /** Fired when an artifact is persisted — the route streams it as an SSE `artifact` event. */
  onArtifact: (artifact: ArtifactMeta) => void;
}

export function buildServerTools(artifacts: ArtifactStore, hooks: ServerToolHooks): AgentTool[] {
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
      run: (input) => {
        if (typeof input.content !== 'string' || input.content === '') {
          return 'Error: "content" must be a non-empty string containing the entire file body.';
        }
        const title = typeof input.title === 'string' ? input.title : undefined;
        const result = artifacts.put({ html: input.content, displayName: title });
        if (!result.ok) return `Error (${result.code}): ${result.message}`;
        hooks.onArtifact(result.artifact);
        return `Created artifact "${result.artifact.displayName}" at ${artifactUrl(result.artifact.id)}`;
      },
    },
  ];
}

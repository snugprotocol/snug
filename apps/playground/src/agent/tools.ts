// tools.ts — the direct-mode chat-path tool set: the browser-side twin of the server's
// buildServerTools. Tool names/descriptions come from the knowledge store (ADR-0004);
// artifact_write flows through an ArtifactSink into the USER DB — the sink pins the
// target app host-side (F9), so a write is an install or a new version, never a
// model-chosen destination.

import type { AgentTool } from '@snugprotocol/adapters';
import { APP_BUILDER_TOOL_NAME, getToolPrompt, searchKnowledge } from '@snugprotocol/knowledge';

import type { ArtifactSink, ArtifactWriteResult } from './artifactSink.js';

export const ARTIFACT_WRITE_TOOL_NAME = 'artifact_write';

export interface ByokToolHooks {
  onArtifact: (artifact: ArtifactWriteResult) => void;
}

export function buildByokTools(sink: ArtifactSink, hooks: ByokToolHooks): AgentTool[] {
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
  ];
}

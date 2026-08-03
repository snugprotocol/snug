// tools.ts — the BYOK chat-path tool set: the browser-side twin of the server's
// buildServerTools. Tool names/descriptions come from the knowledge store (ADR-0004);
// artifact_write lands in the LOCAL library (IndexedDB) instead of the server store.

import type { AgentTool } from '@snugprotocol/adapters';
import { APP_BUILDER_TOOL_NAME, getToolPrompt, searchKnowledge } from '@snugprotocol/knowledge';

import type { LibraryEntry, LibraryStore } from '../state/library.js';

export const ARTIFACT_WRITE_TOOL_NAME = 'artifact_write';

export interface ByokToolHooks {
  onArtifact: (artifact: LibraryEntry) => void;
}

export function buildByokTools(library: LibraryStore, hooks: ByokToolHooks): AgentTool[] {
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
        const artifact = await library.save(input.content, title);
        hooks.onArtifact(artifact);
        return `Created artifact "${artifact.displayName}" at /artifacts/${artifact.id}`;
      },
    },
  ];
}

// The control-plane tool surface (ADR-0068 §2) — and the whole of what the agent can do.
//
// THE RULE, stated once: there is no data-plane tool, ever. Nothing here fetches a URL,
// proxies a request, reads a credential, or runs SQL against the user's file. That is C1's
// "credentials never reach the LLM" applied to the agent that spawned us: an agent holding
// a fetch tool bound to the user's approved connections IS a network principal with their
// credentials, whatever the tool is called. The four names below are frozen by an allowlist
// test that fails on any addition, so a fifth tool is a deliberate act with a review.
//
// The bearer that admits the page to the data plane appears in NO tool result: `snug_open`
// makes this process open the browser, and the fallback prints a command for the user's own
// terminal. A token in a tool result is a token in the model's context and in every
// client's transcript.

import instructions from './instructions.md?raw';

export const TOOL_NAMES = ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps'] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: ToolSchema;
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'snug_status',
    description:
      'Whether the Snug runner is open, the address it serves on, where the user’s file lives, and which brain answers their apps. Call this before anything else.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snug_open',
    description:
      'Open the Snug runner in the user’s browser and return the address. Safe to call when it is already open — it reuses the running runner rather than starting a second one.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Optional app id to open directly, from snug_list_apps.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'snug_hand_in',
    description:
      'Deliver an app to the open runner as a snug-app-bundle/1 document. Installs a new app, or offers the update in the run header when the user has edited their copy. A bundle asking for connections is refused — the user grants those in the runner.',
    inputSchema: {
      type: 'object',
      properties: {
        bundle: { type: 'object', description: 'The snug-app-bundle/1 document.', additionalProperties: true },
      },
      required: ['bundle'],
      additionalProperties: false,
    },
  },
  {
    name: 'snug_list_apps',
    description:
      'The apps already in the user’s file: id, name and version. Use it so an edit updates the right app instead of installing a second copy.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

export function listTools(): readonly ToolDefinition[] {
  return TOOLS;
}

/**
 * The `instructions` string an MCP client reads at `initialize` — the launch protocol.
 *
 * Its home is `src/instructions.md` and it is inlined at build time (D-B12): the prompt
 * store compiles every `.md` under `prompts/` into a committed `content.ts` that the
 * playground, the desktop and the host kit all import, so authoring it there would put
 * process-only text into every bundle — which ADR-0065 D6 forbids. One source, byte-
 * compared by `check-host-mcp`, and read by the skill build when T6 lands.
 */
export function instructionsText(): string {
  return instructions;
}

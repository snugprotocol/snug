// The MCP server: five methods over stdio (ADR-0068 §4).
//
// The protocol version is ECHOED when the client asks for one we understand and pinned to
// ours otherwise — a server that silently answers a version it does not implement is worse
// than one that names the mismatch.

import { instructionsText, listTools, TOOL_NAMES, type ToolName } from '../tools.js';
import { createLineFramer, parseRpcMessage, type RpcId } from './jsonrpc.js';

/** The versions this server implements. The newest is what an unknown ask is answered with. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ServerDeps {
  /** Runs one tool. Errors become an isError result, never a transport failure. */
  callTool(name: ToolName, args: Record<string, unknown>): Promise<ToolResult>;
  serverName?: string;
  serverVersion?: string;
}

export interface McpServer {
  /** Feed one decoded line; returns the reply to write, or undefined for a notification. */
  handleLine(line: string): Promise<string | undefined>;
  /** Wire to a byte stream (stdin). */
  attach(input: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown }, write: (line: string) => void): void;
}

const reply = (id: RpcId, result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, result });
const fail = (id: RpcId | undefined, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : { id: null }), error: { code, message } });

export function createMcpServer(deps: ServerDeps): McpServer {
  const name = deps.serverName ?? 'snug';
  const version = deps.serverVersion ?? '0.1.0';

  const server: McpServer = {
    async handleLine(line: string): Promise<string | undefined> {
      const message = parseRpcMessage(line);

      if (message.kind === 'error') {
        // A malformed NOTIFICATION has no id and must not be answered at all; a malformed
        // request carries its id back so the caller's promise settles.
        return message.id === undefined ? undefined : fail(message.id, message.code, 'invalid request');
      }

      if (message.kind === 'notification') return undefined; // including notifications/initialized

      const { id, method, params } = message;

      switch (method) {
        case 'initialize': {
          const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
          const protocolVersion =
            typeof asked === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_PROTOCOL_VERSION;
          return reply(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name, version },
            // The launch protocol. Claude Code and Codex read this; claude.ai chat drops it.
            instructions: instructionsText(),
          });
        }
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools: listTools() });
        case 'tools/call': {
          const call = params as { name?: unknown; arguments?: unknown } | undefined;
          const toolName = call?.name;
          if (typeof toolName !== 'string' || !(TOOL_NAMES as readonly string[]).includes(toolName)) {
            // An unknown tool is a client error, not a server crash — and naming it keeps
            // the allowlist honest from the outside.
            return fail(id, METHOD_NOT_FOUND, `unknown tool: ${String(toolName)}`);
          }
          const args = (call?.arguments ?? {}) as Record<string, unknown>;
          try {
            return reply(id, await deps.callTool(toolName as ToolName, args));
          } catch (error) {
            // A failing tool is a RESULT with isError, per MCP: the model should see what
            // went wrong rather than the session dropping.
            const text = error instanceof Error ? error.message : String(error);
            return reply(id, { content: [{ type: 'text', text }], isError: true });
          }
        }
        default:
          return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
      }
    },

    attach(input, write): void {
      const framer = createLineFramer((line) => {
        void server
          .handleLine(line)
          .then((answer) => {
            if (answer !== undefined) write(answer);
          })
          .catch((error: unknown) => {
            write(fail(undefined, INTERNAL_ERROR, error instanceof Error ? error.message : String(error)));
          });
      });
      input.on('data', (chunk) => framer.push(chunk));
    },
  };

  return server;
}

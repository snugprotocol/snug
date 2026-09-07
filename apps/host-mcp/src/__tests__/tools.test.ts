// AC6 / the C1 clause "the LLM is never a network principal" (ADR-0068 §2).
//
// This file is the allowlist's home. A data-plane tool — anything that fetches, proxies,
// reads a credential or runs SQL — is forbidden as a RULE, not deferred: an agent holding
// one is a network principal with the user's credentials, which C1 exists to prevent. The
// list below fails on any ADDITION, so a future tool is a deliberate act with a review,
// never a quiet import.

import { describe, expect, it } from 'vitest';

import { instructionsText, listTools, TOOL_NAMES } from '../tools.js';

/** The whole surface. Changing this literal is the review trigger. */
const ALLOWED = ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps'] as const;

describe('the MCP tool surface is an allowlist', () => {
  it('is exactly the four control-plane tools', () => {
    expect(listTools().map((t) => t.name).sort()).toEqual([...ALLOWED].sort());
  });

  it('exports the same four names as the constant the server dispatches on', () => {
    // One source: a tool present in the list but absent from the dispatcher (or the
    // reverse) is the "one contract, two artifacts" defect (lesson 2026-07-31).
    expect([...TOOL_NAMES].sort()).toEqual([...ALLOWED].sort());
  });

  it('carries NO tool whose name suggests a data-plane capability', () => {
    // A belt against the failure mode where someone adds `snug_fetch` and also updates
    // ALLOWED without thinking about what the name means.
    const forbidden = /fetch|http|request|proxy|sql|query|exec|secret|credential|token|key|net/i;
    for (const tool of listTools()) {
      expect(tool.name, `${tool.name} reads as a data-plane tool`).not.toMatch(forbidden);
    }
  });

  it('describes every tool and gives each an object input schema', () => {
    for (const tool of listTools()) {
      expect(tool.description.length, `${tool.name} needs a description`).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('never mentions the bearer, the token or the port in any description or schema', () => {
    // AC4/D-B8: the bearer appears in no MCP message. A description naming it would put
    // it in every client's tool list and in the model's context.
    const rendered = JSON.stringify(listTools());
    expect(rendered).not.toMatch(/bearer|authorization|token/i);
  });
});

describe('the instructions string', () => {
  it('is the launch protocol and names the two tools a session starts with', () => {
    const text = instructionsText();
    expect(text).toMatch(/snug_status/);
    expect(text).toMatch(/snug_open/);
  });

  it('never says "MCP server" or "built on MCP" in product copy (ADR-0061, D-B9)', () => {
    // The positioning rule is a test because copy drifts: MCP is the spawn channel, not
    // what Snug is. The word may appear nowhere a user-facing sentence would carry it.
    expect(instructionsText()).not.toMatch(/Snug MCP server|built on MCP/i);
  });

  it('carries no credential material', () => {
    expect(instructionsText()).not.toMatch(/bearer [A-Za-z0-9]/i);
  });
});

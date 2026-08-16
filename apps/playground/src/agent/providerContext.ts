/**
 * providerContext — connection FACTS for the provider lane (TASK-20260815, ADR-0031 §2).
 *
 * THE BOUNDARY THIS MODULE OWNS: what the provider lane's LLM turn may know about the
 * app's connections. Facts travel — slot, provider name, public API hosts, granted
 * scopes, how to address a request. Three things never do, each for a stated reason:
 *
 *  - CREDENTIAL VALUES (C1): the executor is the only credential reader; nothing here
 *    touches `snug_secrets` at all, so a leak would need a new import, not a slip.
 *  - PRIVATE NETWORK LITERALS (ADR-0026 §3): a LAN row's collected address is the
 *    user's network fact. The lane teaches `snug-connection://<slot>/…` for those rows
 *    and the executor resolves it host-side; `publicHosts` filters RFC-1918 out even
 *    though today's admission rules make a mixed ceiling impossible — the filter is the
 *    guarantee, not the admission trivia.
 *  - NON-APPROVED ROWS: a declared or revoked connection is not a capability. Rendering
 *    it would teach the model to compose requests the executor must then refuse.
 *
 * Public API hostnames are deliberately INCLUDED (plan-review F2): symbolic addressing
 * hard-refuses multi-host ceilings (`allowedHosts.length !== 1`), and every OAuth
 * ceiling is multi-host by derivation (API hosts ∪ endpoint hosts) — so literal
 * `https://<pinned-host>/…` composition is the only sanctioned path for public
 * providers, and a hostname pinned in a reviewed registry is neither a credential nor a
 * private fact.
 */

import { isRfc1918Ipv4Literal, CONNECTION_STATUS } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

export interface ProviderConnectionFacts {
  slot: string;
  providerName: string;
  /** Ceiling hosts the lane may name — RFC-1918 literals filtered OUT unconditionally. */
  publicHosts: string[];
  /** True when the row is LAN-class (a private literal in the ceiling or a lanHost seat). */
  lan: boolean;
  /** Registry-pinned OAuth scopes (ADR-0028) — public review-screen data. */
  scopes: string[];
}

/** Approved rows only, reduced to lane-safe facts. */
export function listProviderConnectionFacts(db: UserDb, appId: string): ProviderConnectionFacts[] {
  return db
    .listConnections(appId)
    .filter((row) => row.status === CONNECTION_STATUS.approved)
    .map((row) => {
      const hosts = row.allowedHosts ?? [];
      const publicHosts = hosts.filter((host) => !isRfc1918Ipv4Literal(host));
      return {
        slot: row.slot,
        providerName: row.requirement.provider.name,
        publicHosts,
        lan: row.requirement.lanHost !== undefined || publicHosts.length < hosts.length,
        scopes: [...(row.requirement.scopes ?? [])],
      };
    });
}

/** `slot (Provider Name)` lines for the intent classifier — identity only, never hosts. */
export function connectionSummaries(db: UserDb, appId: string): string[] {
  return listProviderConnectionFacts(db, appId).map((fact) => `${fact.slot} (${fact.providerName})`);
}

/**
 * The provider lane's context section. `undefined` when the app has no approved
 * connection — the caller renders the honest no-connection statement instead, because a
 * lane that silently omits the section invites the model to invent hosts from training
 * data.
 */
export function buildProviderContextBlock(db: UserDb, appId: string): string | undefined {
  const facts = listProviderConnectionFacts(db, appId);
  if (facts.length === 0) return undefined;

  const lines: string[] = ['### Connected services (approved)'];
  for (const fact of facts) {
    lines.push(`- ${fact.slot} (${fact.providerName})`);
    if (fact.lan) {
      lines.push(
        `  Address requests as \`snug-connection://${fact.slot}/<path>\` — the device's private address stays with the hub and must never be guessed or asked for.`,
      );
    } else if (fact.publicHosts.length > 0) {
      lines.push(`  Address requests as \`https://<host>/<path>\` using one of: ${fact.publicHosts.join(', ')}.`);
    }
    if (fact.scopes.length > 0) {
      lines.push(`  Granted scope: ${fact.scopes.join(', ')} — requests outside it will be refused by the provider.`);
    }
  }
  lines.push(
    '',
    'Requests run through the hub with the user’s stored credentials injected host-side; you never see or send credentials. GET/HEAD answer directly; any change (POST/PUT/PATCH/DELETE) asks the user to confirm first.',
  );
  return lines.join('\n');
}

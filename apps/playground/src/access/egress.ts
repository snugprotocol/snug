// access/egress.ts — "where Budget can send what it reads", DERIVED for the consent sheet
// (TASK-20261010-cross-app-access AC15; ADR-0075 §8).
//
// WHY DERIVED. The sheet's promise is completeness: every place the reader's code can carry
// what it reads, named the way the user knows it. Written copy would drift from the routing it
// describes, so every line here is computed from the same stores and rows the routes read:
//
//   its AI          — `readerAdapterKind` composes EXACTLY as `agent/transport.ts`
//                     `resolveAppTransport` → `createDirectAppTransport` routes a turn: the
//                     platform brain pin → the webllm/demo overrides → subscription → the
//                     per-app provider pin under the SAME `byok && provider !== 'mock'` guard →
//                     key presence (the FILE's secret rows — what the send path reads; the
//                     synchronous presence store can be stale, so it is never consulted) →
//                     `adapterKindFor`. A keyed provider with no key routes to
//                     the demo brain silently by design there, and is said here as
//                     *(key missing)*. Pinned equal to the transport in accessEgress.test.ts.
//   connections     — every APPROVED row's frozen hosts by provider; every DECLARED row's
//                     hosts as *not connected yet*; a revoked row not at all; the WhatsApp
//                     sidecar's symbolic host as the helper by name. Where the app may not reach
//                     the network at all (`appMayReachNetwork`), ONE line — and never "no
//                     network": the brain line above it may well be one.
//   links           — ALWAYS for an owned reader: open-url is bound to every owned app's
//                     visible frame (RunView), whatever its connections.
//   away            — when *also while I'm away* is ticked.
//   closing         — the copy is made here, and the source keeps the history.
//
// Every store is read at the CALL (the transport's own rule: a value captured once would
// disclose yesterday's route). No brain call, nothing async. `egressFor` is the ONE entry a
// sheet renders; `readerAdapterKind` exists for the pin against the transport.

import { CONNECTION_STATUS, SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';

import { adapterKindFor, type AdapterKind } from '../agent/adapter.js';
import { appMayReachNetwork } from '../run/appCapabilityRules.js';
import { isUnownedId } from '../share/sharedInbox.js';
import { appProviderPinFor } from '../state/appModel.js';
import { SECRET_KEY_PREFIX, localUrlStore, modeStore, providerStore, type ByokProvider } from '../state/mode.js';
import { currentBrain } from '../state/webllm.js';
import { BRAIN_NAMES, EGRESS } from './copy.js';

export type EgressKind = 'brain' | 'approved' | 'declared' | 'helper' | 'open-url' | 'no-connections' | 'away' | 'closing';

export interface EgressLine {
  kind: EgressKind;
  text: string;
}

/**
 * The brain a reader's turn routes to. `'subscription'` is the one route that never builds a
 * direct adapter (`createServerAppTransport` — the hub owns the model), so it widens
 * `AdapterKind` exactly as the brain chip's `ActiveBrainKind` does.
 */
export type ReaderBrainKind = AdapterKind | 'subscription';

/** The route behind the kind — what the brain line needs beyond it. */
export interface ReaderBrainRoute {
  kind: ReaderBrainKind;
  /** The provider the transport would hand the adapter (after the per-app pin). */
  provider: ByokProvider;
  /** A keyed provider was chosen but has no key, so the turn falls through to the demo brain. */
  keyMissing: boolean;
  /** The platform brain's label (`host` only). */
  hostLabel?: string;
}

const isKeyed = (provider: ByokProvider): provider is 'anthropic' | 'openai' => provider === 'anthropic' || provider === 'openai';

/** Whether the FILE holds a key for a keyed provider — the rows `getByokKey` reads on the send path. */
const fileHasKey =
  (db: UserDb) =>
  (provider: 'anthropic' | 'openai'): boolean =>
    db.getSecret(`${SECRET_KEY_PREFIX}${provider}`) !== undefined;

/**
 * The route a turn for `appId` would take NOW, in `resolveAppTransport`'s order. `hasKey` is
 * REQUIRED — no default to the synchronous presence store, which can disagree with the file the
 * send path reads (a brain line saying "with your key" for a turn that routes to the demo brain).
 */
export function readerBrainRoute(appId: string, hasKey: (provider: 'anthropic' | 'openai') => boolean): ReaderBrainRoute {
  const provider = providerStore.get();
  const brain = currentBrain();
  if (brain.kind === 'host') {
    return { kind: adapterKindFor({ mode: 'host', provider, hasKey: false }), provider, keyMissing: false, hostLabel: brain.label };
  }
  if (brain.kind === 'webllm') return { kind: adapterKindFor({ mode: 'webllm', provider, hasKey: false }), provider, keyMissing: false };
  if (brain.kind === 'demo') return { kind: adapterKindFor({ mode: 'byok', provider: 'mock', hasKey: false }), provider: 'mock', keyMissing: false };

  const mode = modeStore.get();
  if (mode === 'subscription') return { kind: 'subscription', provider, keyMissing: false };
  const pinned = mode === 'byok' && provider !== 'mock' ? appProviderPinFor(appId) : undefined;
  const effective = pinned ?? provider;
  // local talks to an unauthenticated endpoint and never reads a key (createDirectAppTransport).
  const keyed = mode === 'byok' && isKeyed(effective);
  const present = keyed && hasKey(effective);
  return { kind: adapterKindFor({ mode, provider: effective, hasKey: present }), provider: effective, keyMissing: keyed && !present };
}

/** The brain kind alone — what the app's next turn routes to, key presence read from the file. */
export function readerAdapterKind(db: UserDb, appId: string): ReaderBrainKind {
  return readerBrainRoute(appId, fileHasKey(db)).kind;
}

/** "localhost:11434" from the local endpoint the user set; the raw text when it does not parse. */
function addressOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function brainLine(route: ReaderBrainRoute): EgressLine {
  const text = ((): string => {
    if (route.keyMissing && isKeyed(route.provider)) return EGRESS.keyMissing(BRAIN_NAMES[route.provider].brain);
    switch (route.kind) {
      case 'anthropic':
      case 'openai':
        return EGRESS.keyed(BRAIN_NAMES[route.kind].brain, BRAIN_NAMES[route.kind].provider);
      case 'demo':
        return EGRESS.demo;
      case 'webllm':
        return EGRESS.webllm;
      case 'local':
        return EGRESS.local(addressOf(localUrlStore.get()));
      case 'host':
        return EGRESS.host(route.hostLabel ?? '');
      case 'subscription':
        return EGRESS.subscription;
      default: {
        const never: never = route.kind;
        return never;
      }
    }
  })();
  return { kind: 'brain', text };
}

/** Lines in insertion order with duplicates dropped (two slots may name one host). */
function pushUnique(lines: EgressLine[], line: EgressLine): void {
  if (!lines.some((existing) => existing.kind === line.kind && existing.text === line.text)) lines.push(line);
}

function connectionLines(db: UserDb, readerAppId: string): EgressLine[] {
  const approved: EgressLine[] = [];
  const declared: EgressLine[] = [];
  const helpers: EgressLine[] = [];
  for (const row of db.listConnections(readerAppId)) {
    const isApproved = row.status === CONNECTION_STATUS.approved;
    const isDeclared = row.status === CONNECTION_STATUS.declared;
    if (!isApproved && !isDeclared) continue; // revoked: not a place it can send anything
    const providerName = row.requirement.provider.name;
    for (const host of row.allowedHosts ?? []) {
      if (host === SIDECAR_SYMBOLIC_HOST) {
        pushUnique(helpers, { kind: 'helper', text: isApproved ? EGRESS.helper : EGRESS.helperDeclared });
      } else if (isApproved) {
        pushUnique(approved, { kind: 'approved', text: EGRESS.approved(providerName, host) });
      } else {
        pushUnique(declared, { kind: 'declared', text: EGRESS.declared(providerName, host) });
      }
    }
  }
  const byText = (a: EgressLine, b: EgressLine): number => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  return [...approved.sort(byText), ...declared.sort(byText), ...helpers.sort(byText)];
}

/**
 * Every place `readerAppId` can send what it reads from `sourceName`, in the sheet's order:
 * its AI · its connections (or the one "no connections of its own" line) · the link line ·
 * the away line · the closing sentence.
 */
export function egressFor(db: UserDb, readerAppId: string, opts: { unattended: boolean; sourceName: string }): EgressLine[] {
  const lines: EgressLine[] = [brainLine(readerBrainRoute(readerAppId, fileHasKey(db)))];
  const connections = appMayReachNetwork(readerAppId) ? connectionLines(db, readerAppId) : [];
  if (connections.length > 0) lines.push(...connections);
  else lines.push({ kind: 'no-connections', text: EGRESS.noConnections });
  if (!isUnownedId(readerAppId)) lines.push({ kind: 'open-url', text: EGRESS.openUrl });
  if (opts.unattended) lines.push({ kind: 'away', text: EGRESS.away });
  lines.push({ kind: 'closing', text: EGRESS.closing(opts.sourceName) });
  return lines;
}

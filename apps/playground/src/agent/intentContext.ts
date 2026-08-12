/**
 * intentContext — intent-scoped turn context for an app-attached chat (ADR-0019 D9).
 *
 * `buildAppTurnContext` assembles ONE shape for every message: identity + DDL + every doc
 * + the entire app HTML + "write the ENTIRE updated file". That is right for a rebuild and
 * wrong for everything else — it is why asking a budget app "what did I spend on food?"
 * used to hand the model a rewrite brief.
 *
 * This module keeps that assembler for the feature lane and gives the other lanes what
 * they actually need. The scoping is a SAFETY property as much as a cost one: a turn
 * holding the app's code plus the rewrite instruction is one tool call away from rewriting
 * the app, so the data lane must not hold them. Context scoping and tool scoping are two
 * locks on the same door — the router owns the other one.
 */

import type { UserDb } from '@snugprotocol/db';
import { isDataIntent, isFeatureIntent, type ChatIntent } from '@snugprotocol/protocol';

import { buildAppTurnContext, CONTEXT_CAPS, type AppTurnContext } from './appContext.js';

/** Cap on the DDL shown to a data turn — the same budget the builder context uses. */
const DATA_SCHEMA_CAP = CONTEXT_CAPS.schema;

function capText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n…[truncated to fit the context budget]`;
}

/**
 * Compact `table(col, col)` lines for the classifier and the data lane.
 *
 * Names only, never rows: the classifier decides a LANE, and no routing decision needs a
 * user's actual data. It also keeps the classifier turn small enough to be cheap on every
 * message.
 */
export function tableSummaries(db: UserDb, appId: string): string[] {
  const schema = db.getAppSchema(appId);
  if (schema === undefined) return [];
  return schema.objects
    .filter((object) => object.type === 'table')
    .map((object) => {
      // Column names are parsed out of the verbatim DDL rather than re-queried: the
      // registry IS the schema of record (ADR-0010), and a second source could disagree.
      const columns = /\(([\s\S]*)\)/.exec(object.ddl)?.[1] ?? '';
      const names = columns
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0] ?? '')
        .filter((name) => name !== '' && !/^(primary|foreign|unique|check|constraint)$/i.test(name));
      return `${object.name}(${names.join(', ')})`;
    });
}

/**
 * Build the turn context for an intent.
 *
 * Feature intents delegate to the existing builder assembler unchanged — that path is
 * shipped, tested, and correct for a rebuild. Everything else gets a scoped block.
 */
export async function buildIntentTurnContext(
  db: UserDb,
  appId: string | undefined,
  intent: ChatIntent,
  threadId: string,
): Promise<AppTurnContext> {
  // `schema_change` collapses into the feature lane execution-wise at v1 (owner decision
  // (c)): it routes through the existing `schema_apply` tool, which needs the same code
  // context a feature change does. The classification still differs so the COPY can.
  if (isFeatureIntent(intent)) return buildAppTurnContext(db, appId, threadId);

  // Everything below is the scoped path. History is shared: the conversation belongs to
  // the user, not to the lane.
  const { history } = await buildAppTurnContext(db, undefined, threadId);
  if (appId === undefined) return { history };
  const app = db.getApp(appId);
  if (app === undefined) return { history };

  const parts: string[] = ['## The app you are working with'];
  parts.push(
    [
      `Name: ${app.displayName}`,
      ...(app.description !== undefined ? [`Description: ${app.description}`] : []),
    ].join('\n'),
  );

  const schema = db.getAppSchema(appId);
  parts.push(
    '### The app’s data',
    schema !== undefined && schema.objects.length > 0
      ? capText(schema.objects.map((object) => object.ddl).join(';\n'), DATA_SCHEMA_CAP)
      : '(this app has no data tables yet — none registered)',
  );

  const docs = db.listAppDocs(appId);
  if (docs.length > 0) {
    if (isDataIntent(intent)) {
      // TITLES only. A data answer is grounded in rows, not in the app's design notes,
      // and doc bodies are the single largest thing a data turn could carry for no gain.
      parts.push('### Documentation pages (titles only)', docs.map((doc) => doc.title ?? doc.slug).join(', '));
    } else {
      // `app_question`/`other`: the docs ARE the answer surface, so they come in full.
      parts.push(
        '### App knowledge docs',
        capText(
          docs.map((doc) => `#### ${doc.title ?? doc.slug}\n${doc.content}`).join('\n\n'),
          CONTEXT_CAPS.docs,
        ),
      );
    }
  }

  return { contextBlock: parts.join('\n\n'), history };
}

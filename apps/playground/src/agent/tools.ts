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
  ARTIFACT_EDIT_TOOL_NAME,
  RUNTIME_CONTRACT_WRITE_TOOL_NAME,
  SCHEMA_APPLY_TOOL_NAME,
  getToolPrompt,
  searchKnowledge,
} from '@snugprotocol/knowledge';
import {
  SCHEDULE_CONTEXT_DEFAULT_ROWS,
  SCHEDULE_MAX_STEPS,
  SCHEDULE_TITLE_MAX_CHARS,
  runtimeContractSchema,
  scheduleProposalSchema,
  scheduleSpecSchema,
  type ScheduleProposal,
  type ScheduleSpec,
  type ScheduleStep,
} from '@snugprotocol/protocol';

import { allows } from '../platform/platform.js';
import { describeSpec } from '../schedule/cron.js';
import { frequencyFloorRefusal } from '../schedule/floors.js';
import { readSchedule } from '../schedule/parseScheduleText.js';
import { getUserDb } from '../state/userdb.js';
import type { ArtifactSink, ArtifactWriteResult } from './artifactSink.js';

export const ARTIFACT_WRITE_TOOL_NAME = 'artifact_write';

/**
 * The propose-only schedule tool (TASK-20261009 P1/P2; ADR-0074 §4). Named here like the
 * data and card tools — it has no server twin and no prompt placeholder, so the knowledge
 * store's name table has nothing to inject.
 */
export const SCHEDULE_PROPOSE_TOOL_NAME = 'schedule_propose';

/** Doc slugs are ids, not prose: lowercase, hyphen-separated (matches the standard slugs). */
const DOC_SLUG_RULE = /^[a-z][a-z0-9-]{0,40}$/;

export interface ByokToolHooks {
  onArtifact: (artifact: ArtifactWriteResult) => void;
  /** UI refresh signals for the app's schema/docs panels (child 3). */
  onSchemaApplied?: (appId: string) => void;
  onDocWritten?: (appId: string, slug: string) => void;
  /** The app's runtime contract was authored/replaced (ADR-0018). */
  onRuntimeContractWritten?: (appId: string) => void;
  /**
   * A `schedule_propose` call staged a suggestion (TASK-20261009 P1). The host renders it as
   * a card on the agent's message; `false` means it was NOT staged (one card per turn), and
   * the tool tells the model so. Absent ⇒ no surface can show a suggestion here, and the
   * tool says that instead of pretending.
   */
  onScheduleProposal?: (proposal: ScheduleProposal, appId: string | undefined) => boolean | void;
}

export interface BuildByokToolsOptions {
  /** Injectable for tests; defaults to the page user DB. */
  getDb?: () => Promise<UserDb>;
}

export interface BuildScheduleProposeToolOptions {
  getDb: () => Promise<UserDb>;
  /**
   * The app the thread is pinned to — the HOST-SIDE pin (the sink's target, or the chat's
   * context target), never an id the model names. `undefined` on a thread with no app yet,
   * where only a reminder can be suggested.
   */
  resolveAppId: () => Promise<string | undefined>;
  /** Injectable for tests; the grammar reads relative phrases ("in 20 minutes") against it. */
  now?: () => Date;
  /** Absent ⇒ no surface renders suggestions here; the tool says so rather than staging into the void. */
  onProposal?: ByokToolHooks['onScheduleProposal'];
}

const NO_APP_YET = 'Error: an app-think or app-run step needs an installed app, and this thread has none yet — suggest a reminder (a notify step), or build the app first.';
const OTHER_APP = 'Error: a step may only be for THIS app — leave appId out; the host fills it in.';
const NO_SQL = 'Error: leave queries out of an app-think step — the host hands the app its tables itself. Give the prompt only.';
const NO_WHEN =
  'Error: give "when" as a plain sentence the host can read — "every weekday at 8", "daily at 7am", "mondays and thursdays 5:30 pm", "every 2 hours", "first of the month at 9", "in 20 minutes", "tomorrow at 9", "once on oct 20 at noon" — or a "spec" in the host\'s shape.';

/** The steps in words, for the tool result the model reads back. */
function stepWords(step: ScheduleStep): string {
  switch (step.kind) {
    case 'notify':
      return `remind: ${step.title} — ${step.body}`;
    case 'app-think':
      return `ask the app’s AI: ${step.prompt}`;
    case 'app-run':
      return step.input === undefined ? 'run the app' : `run the app with input ${JSON.stringify(step.input)}`;
    default: {
      const never: never = step;
      return never;
    }
  }
}

/**
 * `schedule_propose` — stages ONE suggestion per turn for the user to enable (or not) on the
 * host's consent surface. It is the whole of the chat's `schedule` lane and rides in the
 * builder's set beside the authoring tools; it cannot create, enable or run anything.
 *
 * THE SINK PINS THE APP (the artifact tools' rule, F9): every app step is for the thread's
 * app, resolved host-side; a step that names another app is refused, and an app step on a
 * thread with no installed app is refused by name. Queries are refused too — a brain never
 * authors the SQL a scheduled step runs (scope F17); the host assembles the app's tables.
 * The parsed proposal goes through the protocol's strict schema and the frequency floor of
 * a suggested schedule BEFORE it is staged, so the card never shows what the writer would
 * then refuse for a reason the model could have fixed.
 */
export function buildScheduleProposeTool(options: BuildScheduleProposeToolOptions): AgentTool {
  const now = options.now ?? (() => new Date());
  return {
    def: {
      name: SCHEDULE_PROPOSE_TOOL_NAME,
      description: getToolPrompt('schedule-propose'),
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          when: { type: 'string' },
          spec: { type: 'object' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['notify', 'app-think', 'app-run'] },
                title: { type: 'string' },
                body: { type: 'string' },
                prompt: { type: 'string' },
                input: {},
              },
              required: ['kind'],
            },
          },
        },
        required: ['title', 'steps'],
      },
    },
    run: async (input) => {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (title === '' || title.length > SCHEDULE_TITLE_MAX_CHARS) {
        return `Error: "title" must be a non-empty string of at most ${SCHEDULE_TITLE_MAX_CHARS} characters.`;
      }
      const rawSteps = Array.isArray(input.steps) ? input.steps : undefined;
      if (rawSteps === undefined || rawSteps.length === 0 || rawSteps.length > SCHEDULE_MAX_STEPS) {
        return `Error: "steps" must be an array of 1 to ${SCHEDULE_MAX_STEPS} steps.`;
      }
      const db = await options.getDb();
      const target = await options.resolveAppId();
      const appId = target !== undefined && db.getApp(target) !== undefined ? target : undefined;

      const steps: ScheduleStep[] = [];
      for (const entry of rawSteps) {
        if (typeof entry !== 'object' || entry === null) return 'Error: each step must be an object with a "kind".';
        const step = entry as Record<string, unknown>;
        if (step.appId !== undefined && step.appId !== appId) return OTHER_APP;
        switch (step.kind) {
          case 'notify':
            steps.push({ kind: 'notify', title: String(step.title ?? ''), body: String(step.body ?? '') });
            break;
          case 'app-think': {
            if (appId === undefined) return NO_APP_YET;
            const context = step.context;
            if (typeof context === 'object' && context !== null && (context as Record<string, unknown>).sql !== undefined) return NO_SQL;
            if (step.sql !== undefined || step.queries !== undefined) return NO_SQL;
            steps.push({ kind: 'app-think', appId, prompt: String(step.prompt ?? ''), context: { maxRows: SCHEDULE_CONTEXT_DEFAULT_ROWS } });
            break;
          }
          case 'app-run':
            if (appId === undefined) return NO_APP_YET;
            steps.push({ kind: 'app-run', appId, ...(step.input !== undefined ? { input: step.input as Extract<ScheduleStep, { kind: 'app-run' }>['input'] } : {}) });
            break;
          default:
            return 'Error: each step\'s "kind" must be one of notify, app-think, app-run.';
        }
      }

      // The when: the sentence first (the user's own words, read by the host's grammar), the
      // protocol shape when the sentence cannot say it.
      const at = now();
      let spec: ScheduleSpec | undefined = typeof input.when === 'string' && input.when.trim() !== '' ? readSchedule(input.when, at, 'device')?.spec : undefined;
      if (spec === undefined && input.spec !== undefined) {
        const parsedSpec = scheduleSpecSchema.safeParse(input.spec);
        if (parsedSpec.success) spec = parsedSpec.data;
      }
      if (spec === undefined) return NO_WHEN;

      // The REAL schema decides (the runtime-contract tool's rule): the JSON-Schema above only
      // shapes the tool list the model sees.
      const parsed = scheduleProposalSchema.safeParse({ title, steps, spec });
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return `Error: the suggestion was rejected — ${issues}`;
      }
      const floor = frequencyFloorRefusal(parsed.data.spec, 'builder', at);
      if (floor !== undefined) return `Error: ${floor} — suggest a slower cadence.`;

      if (options.onProposal === undefined) return 'NOT staged: suggestions cannot be shown in this chat. Tell the user to set the schedule up from the Schedule page.';
      const staged = options.onProposal(parsed.data, appId);
      if (staged === false) {
        return ['NOT staged: a suggestion is already waiting for the user in this turn.', 'Tell the user about it and let them answer it first.'].join(' ');
      }
      return [
        `Suggested (NOT scheduled — the user decides on the card): "${parsed.data.title}" · ${describeSpec(parsed.data.spec)}`,
        ...parsed.data.steps.map((step, i) => `${i + 1}. ${stepWords(step)}`),
        '',
        'Tell the user what you suggested and that it is waiting for their OK on the card.',
      ].join('\n');
    },
  };
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
        name: ARTIFACT_EDIT_TOOL_NAME,
        description: getToolPrompt('artifact-edit'),
        inputSchema: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: { oldString: { type: 'string' }, newString: { type: 'string' } },
                required: ['oldString', 'newString'],
              },
            },
          },
          required: ['edits'],
        },
      },
      run: async (input) => {
        const raw = Array.isArray(input.edits) ? input.edits : undefined;
        if (raw === undefined || raw.length === 0) {
          return 'Error: "edits" must be a non-empty array of {oldString, newString} objects.';
        }
        const edits: Array<{ oldString: string; newString: string }> = [];
        for (const entry of raw) {
          if (typeof entry !== 'object' || entry === null) return 'Error: each edit must be an object.';
          const { oldString, newString } = entry as Record<string, unknown>;
          if (typeof oldString !== 'string' || oldString === '') {
            return 'Error: each edit needs a non-empty "oldString" copied verbatim from the file.';
          }
          if (typeof newString !== 'string') return 'Error: each edit needs a string "newString".';
          edits.push({ oldString, newString });
        }

        const db = await getDb();
        const appId = await sink.ensureTargetId();
        const current = db.getApp(appId) === undefined ? undefined : db.getAppHtml(appId);
        if (current === undefined) {
          return 'Error: this app has no file to edit yet — write the whole file first.';
        }

        /**
         * UNIQUE-MATCH-OR-FAIL, applied to a WORKING COPY.
         *
         * Uniqueness is re-checked against the text as it stands after each earlier edit,
         * because applying edits in sequence can CREATE an ambiguity that did not exist in
         * the original. Nothing is persisted until every edit has succeeded — a
         * half-applied batch would be worse than a refused one.
         */
        let next = current;
        for (const [index, edit] of edits.entries()) {
          const occurrences = next.split(edit.oldString).length - 1;
          if (occurrences === 0) {
            return `Error: edit ${index + 1} did not match — "${edit.oldString.slice(0, 60)}" is not in the file. Nothing was changed.`;
          }
          if (occurrences > 1) {
            return `Error: edit ${index + 1} is ambiguous — "${edit.oldString.slice(0, 60)}" appears ${occurrences} times. Include more surrounding text so it matches exactly once. Nothing was changed.`;
          }
          next = next.replace(edit.oldString, edit.newString);
        }

        // The SAME sink path artifact_write uses, so the result is a version like any
        // other: same pinning, same reload, same contract copy-forward.
        const artifact = await sink.write(next);
        hooks.onArtifact(artifact);
        return `Applied ${edits.length} edit(s) — "${artifact.displayName}" is now version ${artifact.version}.`;
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
    {
      def: {
        name: RUNTIME_CONTRACT_WRITE_TOOL_NAME,
        description: getToolPrompt('runtime-contract-write'),
        inputSchema: {
          type: 'object',
          properties: {
            overview: { type: 'string' },
            personaNote: { type: 'string' },
            stateGuidance: { type: 'string' },
            responseGuidance: { type: 'string' },
            settings: { type: 'object' },
            maxOutputTokens: { type: 'number' },
          },
          required: ['overview'],
        },
      },
      run: async (input) => {
        // The REAL schema does the validating (bounds-at-parse, ADR-0018 D2) — the
        // JSON-Schema above only shapes the tool list the model sees. Re-implementing the
        // bounds here would give the contract two definitions that could disagree.
        const parsed = runtimeContractSchema.safeParse(input);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
          return `Error: the runtime contract was rejected — ${issues}`;
        }
        const db = await getDb();
        const appId = await sink.ensureTargetId();
        // A contract belongs to a VERSION row. Before the first artifact write the sink
        // has pre-minted an id but no app exists, so there is nothing to attach to —
        // saying so beats writing a contract that would be silently lost (AC-F1-2).
        const app = db.getApp(appId);
        if (app === undefined) {
          return 'Error: write the app artifact first — a runtime contract attaches to an app version, and this app has none yet.';
        }
        try {
          db.putRuntimeContract(appId, app.currentVersion, parsed.data);
          hooks.onRuntimeContractWritten?.(appId);
          return `Recorded the runtime contract for v${app.currentVersion}. Its own turns will now be assembled from this, not from the build conversation.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    // TASK-20261009 P1 (ADR-0074 §4): the builder may SUGGEST a schedule for the app it is
    // building — staged on the message, enabled only by the user. Only where this host
    // schedules at all; the sink's pre-minted target counts as "no app yet" until the first
    // artifact write lands, exactly as the runtime-contract tool reads it.
    ...(allows('schedule')
      ? [
          buildScheduleProposeTool({
            getDb,
            resolveAppId: () => sink.ensureTargetId(),
            ...(hooks.onScheduleProposal !== undefined ? { onProposal: hooks.onScheduleProposal } : {}),
          }),
        ]
      : []),
  ];
}

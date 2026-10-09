// agent/scheduleProposeTool.ts — the propose-only schedule tool (TASK-20261009 P1/P2; ADR-0074
// §4; split out of `tools.ts` at Gate-5 PR-B M17). It is the whole of the chat's `schedule` lane
// (`laneTools.ts` imports it lazily, like the data and provider tools) and rides in the builder's
// set beside the authoring tools (`tools.ts`); it cannot create, enable or run anything — the
// one consent surface and the one writer (`enableProposedTask`) do.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { getToolPrompt } from '@snugprotocol/knowledge';
import {
  SCHEDULE_CONTEXT_DEFAULT_ROWS,
  SCHEDULE_MAX_STEPS,
  SCHEDULE_TITLE_MAX_CHARS,
  scheduleProposalSchema,
  scheduleSpecSchema,
  type ScheduleProposal,
  type ScheduleSpec,
  type ScheduleStep,
} from '@snugprotocol/protocol';

import { describeSpec } from '../schedule/cron.js';
import { frequencyFloorRefusal } from '../schedule/floors.js';
import { readSchedule } from '../schedule/parseScheduleText.js';

/**
 * Named here like the data and card tools — it has no server twin and no prompt placeholder,
 * so the knowledge store's name table has nothing to inject.
 */
export const SCHEDULE_PROPOSE_TOOL_NAME = 'schedule_propose';

/**
 * A `schedule_propose` call staged a suggestion. The host renders it as a card on the agent's
 * message; `false` means it was NOT staged (one card per turn), and the tool tells the model so.
 */
export type OnScheduleProposal = (proposal: ScheduleProposal, appId: string | undefined) => boolean | void;

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
  onProposal?: OnScheduleProposal;
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
 * host's consent surface.
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

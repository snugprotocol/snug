// GitHub deep-link feedback (TASK-20260822-feedback-loop, ADR-0052).
//
// There is no hosted feedback receiver — ADR-0013's zero-endpoint claim stands —
// so "sending feedback" means opening a PREFILLED GitHub URL the user reviews
// twice: once in the in-product preview popover (before any navigation — the query
// string reaches github.com the moment the URL is opened) and again on GitHub's
// own compose screen before submitting. The builders here therefore do three
// things that are each load-bearing:
//
//   1. scrub credential-shaped material BEFORE assembly (never merely at display),
//      via the single-homed shape list in security/credentialShapes.ts,
//   2. cap the URL so a giant input cannot overflow GitHub's URL limit silently —
//      every free-text input is bounded and error-text truncation is MARKED, and
//   3. derive preview fields and URL params from ONE entry list per builder, so
//      the preview equals the payload by construction, not by test vigilance.
//
// Prefill mechanics: the repo's issue templates are YAML issue FORMS, which accept
// per-field query params keyed by the field `id` (`what-happened`, `environment`,
// `area`). The required `repro` field is deliberately NOT prefilled — GitHub's own
// required-field gate turns every report into a reproduction request.

import { REPO_DISCUSSIONS_URL, REPO_NEW_ISSUE_URL } from '../config/site.js';
import { scrubCredentialProse } from '../security/credentialShapes.js';

export const MAX_REPORT_URL_CHARS = 7000;

// Bounds on the caller-supplied context (an app name is user-controlled data; the
// cap invariant must not depend on callers being polite).
const MAX_ERROR_TEXT_CHARS = 6000;
const MAX_APP_NAME_CHARS = 120;
const MAX_STARTER_ID_CHARS = 64;
const MAX_STARTER_VERSION_CHARS = 32;
const MAX_ENVIRONMENT_CHARS = 200;

export type ReportSurface = 'build' | 'run' | 'connection-wizard' | 'boot';

export interface BugReportContext {
  surface: ReportSurface;
  /** The error text the surface is already showing the user — nothing more. */
  errorText: string;
  appName?: string;
  starterId?: string;
  starterVersion?: string;
  /** One line, the bug form's own placeholder shape: "Firefox 142 / macOS / byok". */
  environment: string;
}

export interface ReportField {
  label: string;
  value: string;
}

export interface PreparedReport {
  url: string;
  /** What the preview shows — derived from the same entries as the URL params. */
  fields: ReportField[];
}

const SURFACE_LABEL: Record<ReportSurface, string> = {
  build: 'build',
  run: 'app run',
  'connection-wizard': 'connection wizard',
  boot: 'startup',
};

// The bug form's Area dropdown options are exact strings — prefill must byte-match
// one or GitHub ignores it. Only the two the playground can attest to are used.
const AREA_PLAYGROUND = 'apps/playground (hub UI)';
const AREA_EXAMPLES = 'examples (starter apps)';

/** Feedback's scrub is the shared shape list in PROSE mode — one name kept for the call sites/tests. */
export const scrubCredentialShaped = scrubCredentialProse;

/** {label (preview), param (URL field id), value} — one row serves both renditions. */
interface PrefillEntry {
  label: string;
  param: string;
  value: string;
}

function prepared(base: string, template: string | null, entries: PrefillEntry[]): PreparedReport {
  const params = new URLSearchParams(
    [...(template !== null ? [['template', template] as [string, string]] : [])].concat(
      entries.map(({ param, value }) => [param, value] as [string, string]),
    ),
  );
  return {
    url: `${base}?${params.toString()}`,
    fields: entries.map(({ label, value }) => ({ label, value })),
  };
}

/** Slice that never strands a lone lead surrogate at the cut. */
function sliceClean(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
}

export function buildBugReport(ctx: BugReportContext): PreparedReport {
  const surfaceLabel = SURFACE_LABEL[ctx.surface];
  const area = ctx.starterId !== undefined ? AREA_EXAMPLES : AREA_PLAYGROUND;
  const appName = ctx.appName !== undefined ? sliceClean(ctx.appName, MAX_APP_NAME_CHARS) : undefined;
  const starterId = ctx.starterId !== undefined ? sliceClean(ctx.starterId, MAX_STARTER_ID_CHARS) : undefined;
  const starterVersion =
    ctx.starterVersion !== undefined ? sliceClean(ctx.starterVersion, MAX_STARTER_VERSION_CHARS) : undefined;
  const environment = sliceClean(ctx.environment, MAX_ENVIRONMENT_CHARS);
  const scrubbedFull = scrubCredentialShaped(ctx.errorText);
  // ANY shortening carries the marker — a silently pre-capped error text would
  // read as complete to the maintainer triaging it.
  const textFor = (keep: number): string => {
    const cut = sliceClean(scrubbedFull, keep);
    return cut.length < scrubbedFull.length ? `${cut}\n…[truncated]` : cut;
  };
  const scrubbed = textFor(MAX_ERROR_TEXT_CHARS);

  const appLine =
    appName !== undefined || starterId !== undefined
      ? `\napp: ${appName ?? starterId ?? ''}${
          starterId !== undefined
            ? ` (starter \`${starterId}\`${starterVersion !== undefined ? ` v${starterVersion}` : ''})`
            : ''
        }`
      : '';

  const firstLine = scrubbed.split('\n')[0] ?? '';
  const title = `[${surfaceLabel}] ${firstLine.length > 80 ? `${sliceClean(firstLine, 79)}…` : firstLine}`;

  const assemble = (errorText: string): PreparedReport =>
    prepared(REPO_NEW_ISSUE_URL, 'bug_report.yml', [
      { label: 'title', param: 'title', value: title },
      {
        label: 'what happened',
        param: 'what-happened',
        value: `Reported from the playground's ${surfaceLabel} surface.${appLine}\n\nThe error shown:\n\n\`\`\`\n${errorText}\n\`\`\``,
      },
      { label: 'environment', param: 'environment', value: environment },
      { label: 'area', param: 'area', value: area },
    ]);

  let report = assemble(scrubbed);
  if (report.url.length > MAX_REPORT_URL_CHARS) {
    // Trim the ERROR TEXT only — the other entries are bounded above, so the
    // keep=0 assembly always fits. Seed with the raw char budget (one char encodes
    // to ≥1 char, so it is a valid upper bound) and let the halving loop absorb
    // percent-encoding expansion (up to 9× for astral chars).
    let keep = Math.max(0, MAX_REPORT_URL_CHARS - assemble(textFor(0)).url.length);
    report = assemble(textFor(keep));
    while (report.url.length > MAX_REPORT_URL_CHARS && keep > 0) {
      keep = Math.floor(keep / 2);
      report = assemble(textFor(keep));
    }
  }
  return report;
}

/** The general-entry bug route: no error context exists, so only the template and
    the environment stamp are prefilled — the user's words fill the rest on GitHub. */
export function buildBlankBugReport(environment: string): PreparedReport {
  return prepared(REPO_NEW_ISSUE_URL, 'bug_report.yml', [
    { label: 'environment', param: 'environment', value: sliceClean(environment, MAX_ENVIRONMENT_CHARS) },
  ]);
}

export function buildFeatureRequest(): PreparedReport {
  // No prefill beyond the template: the form's own required fields (problem,
  // proposal) are the user's words, and prefilling them would put OUR words there.
  return prepared(REPO_NEW_ISSUE_URL, 'feature_request.yml', []);
}

export function buildFeedbackDiscussion(): PreparedReport {
  // Free-form feedback goes to Discussions — the repo's sanctioned "questions &
  // ideas" channel (its issue templates disable blank issues on purpose).
  return { url: `${REPO_DISCUSSIONS_URL}/new?category=general`, fields: [] };
}

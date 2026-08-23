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
//   2. cap the URL so a giant error text cannot overflow GitHub's URL limit
//      silently — truncation is MARKED in the text, and
//   3. return the prefill as named fields beside the URL, so the preview renders
//      exactly the params the URL carries (pinned by test: the preview IS the
//      payload).
//
// Prefill mechanics: the repo's issue templates are YAML issue FORMS, which accept
// per-field query params keyed by the field `id` (`what-happened`, `environment`,
// `area`). The required `repro` field is deliberately NOT prefilled — GitHub's own
// required-field gate turns every report into a reproduction request.

import { REPO_DISCUSSIONS_URL, REPO_NEW_ISSUE_URL } from '../config/site.js';

export const MAX_REPORT_URL_CHARS = 7000;

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
  /** What the preview shows — byte-equal to the URL's prefill params. */
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

/**
 * Best-effort redaction of credential-shaped material from error prose.
 *
 * DOCUMENTED BOUNDARY (the scrub.ts A3 precedent): patterns, not knowledge — this
 * module deliberately does NOT read the credential store to learn real values
 * (that would be a new reader of `snug_secrets` for a non-custody purpose), so a
 * secret that matches no shape below survives. The preview-confirm step is the
 * honest mitigation: the user sees exactly what the URL carries before it opens.
 */
export function scrubCredentialShaped(text: string): string {
  let out = text;
  // Scheme-carrying header values ("Authorization: Bearer <tok>", bare "Basic <tok>").
  out = out.replace(/\b(Bearer|Basic|Token|Digest|Negotiate)\s+[A-Za-z0-9+/=_.~-]{8,}/gi, '$1 ***');
  // Well-known key shapes: GitHub tokens, Anthropic/OpenAI keys, Slack, Google, AWS.
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '***');
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '***');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}(?:-[A-Za-z0-9_-]+)*/g, '***');
  out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '***');
  out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '***');
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, '***');
  // Credential-shaped query params — the value only, the rest of the URL survives.
  out = out.replace(
    /([?&](?:key|apikey|api_key|appid|token|access_token|refresh_token|client_secret|secret|sig|signature|x-amz-signature)=)[^&\s"']+/gi,
    '$1***',
  );
  // Long unbroken token-like runs (raw echoed secrets): 40+ chars of base64-ish
  // alphabet containing at least one digit. Plain words never reach this shape;
  // redacting the occasional long hash is an accepted false positive — this is a
  // feedback body, not data. The digit check lives in a callback (not a regex
  // lookahead) so a pathological input stays linear-time.
  out = out.replace(/[A-Za-z0-9+/=_-]{40,}/g, (run) => (/\d/.test(run) ? '***' : run));
  return out;
}

function prepared(base: string, fields: ReportField[], params: Array<[string, string]>): PreparedReport {
  const search = new URLSearchParams(params);
  const query = search.toString();
  return { url: query === '' ? base : `${base}?${query}`, fields };
}

export function buildBugReport(ctx: BugReportContext): PreparedReport {
  const surfaceLabel = SURFACE_LABEL[ctx.surface];
  const area = ctx.starterId !== undefined ? AREA_EXAMPLES : AREA_PLAYGROUND;
  const scrubbed = scrubCredentialShaped(ctx.errorText);

  const appLine =
    ctx.appName !== undefined || ctx.starterId !== undefined
      ? `\napp: ${ctx.appName ?? ctx.starterId ?? ''}${
          ctx.starterId !== undefined
            ? ` (starter \`${ctx.starterId}\`${ctx.starterVersion !== undefined ? ` v${ctx.starterVersion}` : ''})`
            : ''
        }`
      : '';

  const bodyFor = (errorText: string): string =>
    `Reported from the playground's ${surfaceLabel} surface.${appLine}\n\nThe error shown:\n\n\`\`\`\n${errorText}\n\`\`\``;

  const firstLine = scrubbed.split('\n')[0] ?? '';
  const title = `[${surfaceLabel}] ${firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine}`;

  const assemble = (errorText: string): PreparedReport => {
    const body = bodyFor(errorText);
    return prepared(
      REPO_NEW_ISSUE_URL,
      [
        { label: 'title', value: title },
        { label: 'what happened', value: body },
        { label: 'environment', value: ctx.environment },
        { label: 'area', value: area },
      ],
      [
        ['template', 'bug_report.yml'],
        ['title', title],
        ['what-happened', body],
        ['environment', ctx.environment],
        ['area', area],
      ],
    );
  };

  let report = assemble(scrubbed);
  if (report.url.length > MAX_REPORT_URL_CHARS) {
    // Trim the ERROR TEXT only — environment and area always survive. Encoding
    // expands unpredictably (worst case 3×), so shrink until it fits.
    const overhead = assemble('').url.length;
    let keep = Math.max(0, Math.floor((MAX_REPORT_URL_CHARS - overhead) / 3) - 24);
    report = assemble(`${scrubbed.slice(0, keep)}\n…[truncated]`);
    while (report.url.length > MAX_REPORT_URL_CHARS && keep > 0) {
      keep = Math.floor(keep / 2);
      report = assemble(`${scrubbed.slice(0, keep)}\n…[truncated]`);
    }
  }
  return report;
}

export function buildFeatureRequest(): PreparedReport {
  // No prefill beyond the template: the form's own required fields (problem,
  // proposal) are the user's words, and prefilling them would put OUR words there.
  return prepared(REPO_NEW_ISSUE_URL, [], [['template', 'feature_request.yml']]);
}

export function buildFeedbackDiscussion(): PreparedReport {
  // Free-form feedback goes to Discussions — the repo's sanctioned "questions &
  // ideas" channel (its issue templates disable blank issues on purpose).
  return { url: `${REPO_DISCUSSIONS_URL}/new?category=general`, fields: [] };
}

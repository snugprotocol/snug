// Shared shapes for the in-shell gate harness (TASK-20260812 P4).

export interface CheckResult {
  id: string;
  pass: boolean;
  detail: string;
  /** True for verdicts that need real outbound network (the jsdelivr positive
   *  control) — reported distinctly so an offline failure is diagnosable. */
  networkDependent?: boolean;
}

export interface JourneyStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface JourneyResult {
  steps: JourneyStep[];
  pass: boolean;
}

export interface GateEnvReport {
  origin: string;
  isSecureContext: boolean;
  /** Probed BEFORE the subtle fallback installs — the webview's native truth. */
  nativeCryptoSubtle: boolean;
  userAgent: string;
}

export interface GateResults {
  env: GateEnvReport;
  checks: CheckResult[];
  journey: JourneyResult;
  /** Set when the harness died before completing — the driver fails on it. */
  fatal?: string;
}

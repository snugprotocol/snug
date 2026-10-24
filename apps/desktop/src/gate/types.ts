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

/**
 * `gate_chatgpt_session_stat`'s answer (gate.rs; TASK-20261023-siwc-chatgpt-plan AC13):
 * existence and permission bits of the ChatGPT-plan session file and its directory — never
 * bytes, so a session body cannot reach the results through this seam. Modes are `null` when
 * the path does not exist; the harness masks them to the low nine bits before comparing.
 */
export interface ChatgptSessionStat {
  exists: boolean;
  fileMode: number | null;
  dirMode: number | null;
}

export interface GateResults {
  env: GateEnvReport;
  checks: CheckResult[];
  journey: JourneyResult;
  /** Set when the harness died before completing — the driver fails on it. */
  fatal?: string;
}

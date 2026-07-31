// @snugprotocol/runner — the sandboxed execution surface for untrusted LLM-authored
// HTML apps (hard constraint C2): CSP injection, the framework-agnostic bridge host,
// the React iframe wrapper, and the transport/db/budget seams other packages implement.

export { RUNNER_CSP, injectCsp } from './csp.js';

export {
  MAX_IN_FLIGHT,
  createRunnerHost,
  type FrameDirection,
  type RunnerHost,
  type RunnerHostBaseOptions,
  type RunnerHostCallbacks,
  type RunnerHostOptions,
  type ThemeName,
} from './host.js';

export {
  type AgentTransport,
  type AgentTransportOptions,
  type BudgetStore,
  type DbDriver,
  type DbDriverResult,
  type TransportResult,
} from './transport.js';

export { SnugAppFrame, type SnugAppFrameProps } from './react/SnugAppFrame.js';

export {
  BROWSER_CSP_CHECKS,
  CSP_VERDICT_MESSAGE_TYPE,
  type BrowserCspCheck,
} from './browser-csp.spec.template.js';

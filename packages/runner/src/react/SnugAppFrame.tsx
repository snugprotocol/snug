import { useEffect, useRef, type CSSProperties, type MutableRefObject, type ReactElement, type Ref } from 'react';
import { injectCsp } from '../csp.js';
import { createRunnerHost, type RunnerHost, type RunnerHostBaseOptions, type RunnerHostOptions } from '../host.js';
import type { DbDriver } from '../transport.js';

export type SnugAppFrameProps = Omit<RunnerHostBaseOptions, 'iframe'> &
  ({ db: DbDriver; dbNamespace: string } | { db?: undefined; dbNamespace?: undefined }) & {
    /** The untrusted app HTML. RUNNER_CSP is injected before it ever reaches the iframe. */
    html: string;
    className?: string;
    style?: CSSProperties;
    /** Accessible name for the iframe; defaults to "Snug app". */
    title?: string;
    /**
     * Receives the live RunnerHost controls ({destroy, reset, setTheme, notifyEvent})
     * so the embedder can drive the explicit user reset the parse budget requires (R6).
     */
    controlsRef?: Ref<RunnerHost | null>;
  };

function applyRef(ref: Ref<RunnerHost | null> | undefined, value: RunnerHost | null): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as MutableRefObject<RunnerHost | null>).current = value;
}

/**
 * React binding for the runner host: a sandboxed iframe (`sandbox="allow-scripts"`,
 * exactly — hard constraint C2) whose srcDoc is assigned in an effect strictly AFTER
 * the host attached its listeners.
 *
 * Semantics (deliberate, documented):
 * - The host is keyed on the mounted iframe element and created once per mount.
 *   Identity options (transport, budgetKey, budgetStore, db, dbNamespace, locale) are
 *   captured at mount — pass a React `key` to remount when they must change.
 * - `html` changes flow through the RESET path, not host recreation: the same host
 *   persists, the srcdoc reassignment is counted as an expected load, and in-flight
 *   work is superseded with SUPERSEDED terminal frames on the reload — never dropped
 *   silently. The parse budget is host-owned and survives html changes.
 * - StrictMode-safe: the double-invoked mount effect destroys and recreates the host
 *   idempotently; callbacks always dispatch to the latest props via a ref.
 * - `theme` is live: prop changes call `host.setTheme` without remounting.
 */
export function SnugAppFrame(props: SnugAppFrameProps): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<RunnerHost | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Host lifecycle — MUST be declared before the srcDoc effect: React runs effects in
  // declaration order, which is what upholds the listener-before-srcDoc contract on
  // mount and on every StrictMode remount.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const initial = propsRef.current;
    const host = createRunnerHost({
      iframe,
      transport: initial.transport,
      budgetKey: initial.budgetKey,
      budgetStore: initial.budgetStore,
      theme: initial.theme,
      locale: initial.locale,
      onAnnounce: (frame) => propsRef.current.onAnnounce?.(frame),
      onAppEvent: (event, data) => propsRef.current.onAppEvent?.(event, data),
      onFrame: (direction, frame) => propsRef.current.onFrame?.(direction, frame),
      onBudgetExhausted: () => propsRef.current.onBudgetExhausted?.(),
      onNavigatedAway: () => propsRef.current.onNavigatedAway?.(),
      ...(initial.db !== undefined ? { db: initial.db, dbNamespace: initial.dbNamespace } : {}),
    } as RunnerHostOptions);
    hostRef.current = host;
    applyRef(propsRef.current.controlsRef, host);
    return () => {
      applyRef(propsRef.current.controlsRef, null);
      hostRef.current = null;
      host.destroy();
    };
    // Identity options are mount-captured by design (see doc comment).
  }, []);

  // srcDoc assignment — always after the host effect above (declaration order).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.srcdoc = injectCsp(props.html);
  }, [props.html]);

  useEffect(() => {
    if (props.theme !== undefined) hostRef.current?.setTheme(props.theme);
  }, [props.theme]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      className={props.className}
      style={props.style}
      title={props.title ?? 'Snug app'}
    />
  );
}

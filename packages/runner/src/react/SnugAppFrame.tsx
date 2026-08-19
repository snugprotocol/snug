import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactElement, type Ref } from 'react';
import { injectCsp } from '../csp.js';
import { createRunnerHost, type RunnerHost, type RunnerHostBaseOptions, type RunnerHostOptions } from '../host.js';
import type { DbDriver, NetHandler, OpenUrlHandler } from '../transport.js';

export type SnugAppFrameProps = Omit<RunnerHostBaseOptions, 'iframe'> &
  ({ db: DbDriver; dbNamespace: string } | { db?: undefined; dbNamespace?: undefined }) &
  ({ net: NetHandler; netAppId: string } | { net?: undefined; netAppId?: undefined }) & {
    /** The open-url capability (ADR-0038 D5) — mount-captured like db/net. */
    openUrl?: OpenUrlHandler;
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
 *   Identity options (transport, budgetKey, budgetStore, db, dbNamespace, net, netAppId,
 *   locale) are captured at mount — pass a React `key` to remount when they must change.
 * - `html` changes flow through the RESET path, not host recreation: the same host
 *   persists, the srcdoc reassignment is counted as an expected load, and in-flight
 *   work is superseded with SUPERSEDED terminal frames on the reload — never dropped
 *   silently. The parse budget is host-owned and survives html changes.
 * - StrictMode-safe: the double-invoked mount effect destroys and recreates the host
 *   idempotently; callbacks always dispatch to the latest props via a ref. Each host
 *   instance additionally gets its OWN iframe element (`key={epoch}`): reassigning the
 *   same srcdoc to a reused element leaves Chromium's compositor blank in dev
 *   StrictMode, so when the effect re-runs against an element that already carried a
 *   destroyed host, it bumps the key instead — the replacement host's first srcdoc
 *   assignment lands on a fresh element, which always paints.
 * - `theme` is live: prop changes call `host.setTheme` without remounting.
 */
export function SnugAppFrame(props: SnugAppFrameProps): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hostRef = useRef<RunnerHost | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /** One iframe element per host instance (see StrictMode note above). */
  const [epoch, setEpoch] = useState(0);
  /** Elements that have already carried a host — a reused one must be remounted. */
  const usedIframes = useRef<WeakSet<HTMLIFrameElement> | null>(null);
  usedIframes.current ??= new WeakSet();

  // Host lifecycle — MUST be declared before the srcDoc effect: React runs effects in
  // declaration order, which is what upholds the listener-before-srcDoc contract on
  // mount and on every StrictMode remount.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (usedIframes.current?.has(iframe) === true) {
      // This element already hosted a (now-destroyed) host: its srcdoc has been
      // assigned once, and a reassignment may never repaint (dev StrictMode blank
      // frame). Remount a fresh element; this effect re-runs against it via `epoch`.
      setEpoch((current) => current + 1);
      return;
    }
    usedIframes.current?.add(iframe);
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
      ...(initial.net !== undefined ? { net: initial.net, netAppId: initial.netAppId } : {}),
      ...(initial.openUrl !== undefined ? { openUrl: initial.openUrl } : {}),
    } as RunnerHostOptions);
    hostRef.current = host;
    applyRef(propsRef.current.controlsRef, host);
    return () => {
      applyRef(propsRef.current.controlsRef, null);
      hostRef.current = null;
      host.destroy();
    };
    // Identity options are mount-captured by design (see doc comment); `epoch` re-runs
    // this effect against the freshly keyed iframe element.
  }, [epoch]);

  // srcDoc assignment — always after the host effect above (declaration order).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.srcdoc = injectCsp(props.html);
  }, [props.html, epoch]);

  useEffect(() => {
    // host.setTheme is a no-op when the theme is unchanged, so the mount-time call
    // (host already created with this theme) posts no noise event.
    if (props.theme !== undefined) hostRef.current?.setTheme(props.theme);
  }, [props.theme, epoch]);

  return (
    <iframe
      key={epoch}
      ref={iframeRef}
      sandbox="allow-scripts"
      className={props.className}
      style={props.style}
      title={props.title ?? 'Snug app'}
    />
  );
}

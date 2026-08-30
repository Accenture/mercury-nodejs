/**
 * Minimalist telemetry: distributed trace context for polyglot functions.
 *
 * The engines carry trace_id / trace_path / cid inside the event envelope.
 * The server installs them in an AsyncLocalStorage around each handler call;
 * annotations ride back on the reply envelope's `annotations` field.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// The business correlation-id rides an engine-managed envelope tag - never an
// envelope header - and is injected into the receiving function's input header
// copy as a read-only view at delivery (the engines' WorkerHandler contract).
export const MY_CID_TAG = 'my_cid';
export const MY_CORRELATION_ID = 'my_correlation_id';
// The engines' RPC round-trip marker tag: an RPC leg emits no trace dataset
// (its metrics fold into the caller's view), so the client stamps it on
// request() calls and the bus honors it at delivery.
export const RPC_TAG = 'rpc';
// Reserved application log-context tokens (the engines' LogContext contract):
// resolved live per log line; a developer cannot override them via
// updateContext. The output key names in app-log-context.yaml are the
// operator's choice - this set governs the template tokens and developer API.
export const RESERVED_CONTEXT_TOKENS = new Set(
  ['cid', 'traceId', 'tracePath', 'spanId', 'parentSpanId', 'service', 'utc']);

export interface TraceInfo {
  // the executing function's route - outbound calls fill their sender ("from")
  // with it, the engines' PostOffice.touch parity
  route?: string;
  traceId?: string;
  tracePath?: string;
  cid?: string;
  myCorrelationId?: string;
  // span lineage (the engines' model): spanId is THIS execution's span,
  // stamped onto outbound events so the receiver stores it as its
  // parentSpanId; parentSpanId is the caller's span from the inbound
  // envelope. 16-hex (W3C-shaped).
  spanId?: string;
  parentSpanId?: string;
  annotations: Record<string, unknown>;
  // developer-supplied application log-context key-values (updateContext) -
  // a logging-only sink, rendered into the "context" block of structured log
  // lines; distinct from annotations, which feed the trace telemetry
  customContext?: Record<string, unknown>;
}

const storage = new AsyncLocalStorage<TraceInfo>();

/** The trace context of the event being handled, if any. */
export function getTrace(): TraceInfo | undefined {
  return storage.getStore();
}

/** Attach an annotation to the current trace (returned on the reply envelope). */
export function annotateTrace(key: string, value: unknown): void {
  const info = storage.getStore();
  if (info) {
    info.annotations[String(key)] = value;
  }
}

/**
 * Add (or remove, when value is null/undefined) a custom key-value in the
 * application log context - the engines' PostOffice.updateContext twin.
 *
 * The key-value is rendered into the "context" block of structured log output
 * (log.format json/compact) when the app-log-context feature is enabled.
 * Unlike annotateTrace (which feeds the distributed-trace telemetry), this is
 * a logging-only sink. No-op outside a hosted request.
 *
 * @throws Error if key is one of the reserved context tokens
 */
export function updateContext(key: string, value: unknown): void {
  if (RESERVED_CONTEXT_TOKENS.has(key)) {
    throw new Error(`Cannot override reserved log context key '${key}' - ` +
      `reserved keys are ${[...RESERVED_CONTEXT_TOKENS].sort((a, b) => a.localeCompare(b)).join(', ')}`);
  }
  const info = storage.getStore();
  if (!info) {
    return;
  }
  info.customContext ??= {};
  if (value === null || value === undefined) {
    delete info.customContext[key];
  } else {
    info.customContext[key] = value;
  }
}

/**
 * Run fn under a trace context - the python trace_context twin. Useful for
 * callers outside a hosted function (batch jobs, tests) whose PostOffice
 * calls should carry a trace: the client inherits the context into the
 * outbound envelope, including the business correlation-id as the
 * engine-managed my_cid tag.
 */
export function runWithTrace<T>(info: TraceInfo | undefined, fn: () => T): T {
  // undefined detaches: long-lived internal tasks run with a clean context
  return storage.run(info as TraceInfo, fn);
}

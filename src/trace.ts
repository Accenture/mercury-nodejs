/**
 * Minimalist telemetry: distributed trace context for polyglot functions.
 *
 * The engines carry trace_id / trace_path / cid inside the event envelope.
 * The server installs them in an AsyncLocalStorage around each handler call;
 * annotations ride back on the reply envelope's `annotations` field.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceInfo {
  traceId?: string;
  tracePath?: string;
  cid?: string;
  annotations: Record<string, unknown>;
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

/** internal - run fn under a trace context */
export function runWithTrace<T>(info: TraceInfo, fn: () => T): T {
  return storage.run(info, fn);
}

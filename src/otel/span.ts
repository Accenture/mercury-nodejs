/**
 * The telemetry dataset -> OpenTelemetry span mapping (the engines'
 * `TraceMetricsSpanData` / the Rust port's `span.rs`).
 *
 * The host has already produced the W3C-compatible trace id, span id and parent
 * span id during execution, so the span built here carries those EXACT ids - an
 * OpenTelemetry tracer would mint new ones and break the lineage. A dataset whose
 * ids are not W3C-valid (32 / 16 lowercase hex, not all zeros) is skipped rather
 * than exported with forged ids.
 *
 * | Dataset metric | Span |
 * |----------------|------|
 * | `id` | trace id |
 * | `span_id` | span id |
 * | `parent_span_id` | parent span id (a root span when absent) |
 * | `service` (route) | span name (`path`, then `task`, when absent) |
 * | `start` + `exec_time` | start / end timestamps |
 * | `success` / `status` / `exception` | status OK, or ERROR with a description |
 * | `service` = `http.request` (the edge's round-trip record) | kind SERVER (every function execution is INTERNAL) |
 * | `path`, `from`, `origin`, `status`, `exec_time_ms`, `round_trip_ms`, `exception` | attributes |
 * | `service` | the `route` attribute |
 * | `annotations` entries | `annotation.<key>` attributes |
 */

const NANOS_PER_MILLI = 1_000_000;
const HTTP_REQUEST = 'http.request';

// OTLP SpanKind - only the two values the datasets produce
export const KIND_INTERNAL = 1;
export const KIND_SERVER = 2;

// OTLP StatusCode
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

/** An OTLP AnyValue - the scalar shapes the mapping emits. */
export type AttributeValue =
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'double'; value: number };

/** One completed span, ready for the OTLP encoder. */
export interface Span {
  traceId: Uint8Array;
  spanId: Uint8Array;
  parentSpanId?: Uint8Array;
  name: string;
  kind: number;
  startUnixNano: bigint;
  endUnixNano: bigint;
  attributes: Array<[string, AttributeValue]>;
  statusCode: number;
  statusMessage: string;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** The value of a span attribute, as text (numbers rendered the way the collector tests read them). */
export function attribute(span: Span, key: string): string | undefined {
  const found = span.attributes.find(([k]) => k === key);
  return found ? String(found[1].value) : undefined;
}

/**
 * Map one telemetry dataset (`{trace: {...}, annotations: {...}}`) to a span -
 * undefined when the dataset has no `trace` block or its trace / span id is
 * not W3C-valid.
 */
export function spanFromDataset(dataset: unknown): Span | undefined {
  if (!isRecord(dataset)) return undefined;
  const trace = dataset.trace;
  if (!isRecord(trace)) return undefined;
  const traceId = hexId(trace.id, 16);
  const spanId = hexId(trace.span_id, 8);
  if (!traceId || !spanId) return undefined;
  const parentSpanId = hexId(trace.parent_span_id, 8);
  const annotations = isRecord(dataset.annotations) ? dataset.annotations : {};
  const startText = display(trace.start);
  const startUnixNano = (startText !== undefined ? parseIso8601Nanos(startText) : undefined)
    ?? nowNanos();
  const execMs = toNumber(trace.exec_time);
  const endUnixNano = startUnixNano + BigInt(Math.trunc(execMs * NANOS_PER_MILLI));
  let statusCode = STATUS_OK;
  let statusMessage = '';
  if (!toBool(trace.success)) {
    statusCode = STATUS_ERROR;
    statusMessage = display(trace.exception) ?? `status=${display(trace.status) ?? 'null'}`;
  }
  const service = display(trace.service);
  const path = display(trace.path);
  const name = service ?? path ?? 'task';
  // the edge's round-trip record (service "http.request", emitted by an engine's REST
  // automation when the response completes) is the SERVER span; every function execution
  // - including the first one, whose "from" is http.request - is an INTERNAL hop under it
  const kind = service === HTTP_REQUEST ? KIND_SERVER : KIND_INTERNAL;
  const attributes: Array<[string, AttributeValue]> = [];
  const putStr = (key: string, value: string | undefined): void => {
    if (value !== undefined) attributes.push([key, { type: 'string', value }]);
  };
  putStr('route', service);
  putStr('from', display(trace.from));
  putStr('origin', display(trace.origin));
  putStr('path', path);
  if (trace.status !== undefined && trace.status !== null) {
    attributes.push(['status', { type: 'int', value: toInt(trace.status) }]);
  }
  attributes.push(['exec_time_ms', { type: 'double', value: execMs }]);
  if (trace.round_trip !== undefined && trace.round_trip !== null) {
    attributes.push(['round_trip_ms', { type: 'double', value: toNumber(trace.round_trip) }]);
  }
  const exception = display(trace.exception);
  if (exception !== undefined) {
    attributes.push(['exception', { type: 'string', value: exception }]);
  }
  for (const [key, value] of Object.entries(annotations)) {
    const text = display(value);
    if (text !== undefined) attributes.push([`annotation.${key}`, { type: 'string', value: text }]);
  }
  return { traceId, spanId, parentSpanId, name, kind, startUnixNano, endUnixNano, attributes,
           statusCode, statusMessage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    !(value instanceof Uint8Array);
}

/** Java `String.valueOf(value)`: text for scalars, JSON for structures, undefined when missing. */
function display(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Java `toDouble`: a number, a parseable string, else 0. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && value.trim() !== '' ? parsed : 0;
  }
  return 0;
}

/** Java `toLong`: a number's integer value, a parseable string, else 0. */
function toInt(value: unknown): number {
  return Math.trunc(toNumber(value));
}

/** Java `toBool`: a boolean, or the text `true` (case-insensitive); a missing value means success. */
function toBool(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

/** A W3C id: exactly `2 * size` lowercase hex digits, not all zeros. */
function hexId(value: unknown, size: number): Uint8Array | undefined {
  const text = display(value);
  if (text === undefined || text.length !== 2 * size || !/^[0-9a-f]+$/.test(text)) {
    return undefined;
  }
  const raw = Uint8Array.from(Buffer.from(text, 'hex'));
  return raw.some((b) => b !== 0) ? raw : undefined;
}

function nowNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/**
 * Parse an ISO-8601 UTC instant (`YYYY-MM-DDTHH:MM:SS[.fraction]Z`, the shape the
 * engines and this host write) to nanoseconds since the Unix epoch - the inverse of
 * the envelope formatter, with no date library (days from civil per Howard Hinnant).
 */
export function parseIso8601Nanos(text: string): bigint | undefined {
  const b = text.trim();
  if (b.length < 20) return undefined;
  if (b[4] !== '-' || b[7] !== '-' || !'Tt'.includes(b[10]) || b[13] !== ':' || b[16] !== ':') {
    return undefined;
  }
  const parts = [b.slice(0, 4), b.slice(5, 7), b.slice(8, 10), b.slice(11, 13), b.slice(14, 16),
                 b.slice(17, 19)];
  if (!parts.every((p) => /^\d+$/.test(p))) return undefined;
  const [year, month, day, hour, minute, second] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  let pos = 19;
  let nanos = 0n;
  if (b[pos] === '.') {
    pos += 1;
    const start = pos;
    while (pos < b.length && /\d/.test(b[pos])) pos += 1;
    const digits = b.slice(start, pos);
    if (!digits || digits.length > 9) return undefined;
    nanos = BigInt(digits.padEnd(9, '0'));
  }
  if (pos + 1 !== b.length || !'Zz'.includes(b[pos])) return undefined;
  const days = daysFromCivil(year, month, day);
  const secs = days * 86_400 + hour * 3600 + minute * 60 + second;
  if (secs < 0) return undefined;
  return BigInt(secs) * 1_000_000_000n + nanos;
}

/** Days since 1970-01-01 for a proleptic Gregorian date. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * The OTLP/HTTP export: one request per span through the runtime's fetch, with
 * the engines' retry policy and failure diagnostics (the Rust port's `export.rs`,
 * the Java `OtelForwarderContext`).
 *
 * Retry: telemetry delivery is at-least-once by design - duplicates are tolerated,
 * drops are what hurt - so a transport failure (connect refused, TLS, a killed
 * keep-alive, a timeout) and the retryable HTTP statuses (408, 429, 502, 503, 504)
 * are retried on the OpenTelemetry SDK's default bounded backoff: 5 attempts, 1 s
 * growing by 1.5x. Any other status fails at once - a 401 will not get better by
 * waiting.
 *
 * Diagnostics: a rejected export is actionable from the forwarder's own warning
 * line: the status leads, the backend's response body follows (whitespace-collapsed,
 * bounded), and the rejections that actually happen get a hint. Request headers are
 * never rendered, so no credential can reach the log.
 */
import { getLogger } from '../log.js';
import { ENDPOINT, ForwarderSettings } from './config.js';
import { encodeExportRequest, partialSuccess } from './otlp.js';
import { hex, Span } from './span.js';

const log = getLogger('mercury.otel');

export const INSTRUMENTATION_SCOPE = 'mercury-composable-nodejs';
/** Statuses worth another attempt (the OpenTelemetry SDK's set, plus 408). */
export const RETRYABLE_STATUSES = [408, 429, 502, 503, 504];
/** The waits between attempts: 5 attempts, 1 s x 1.5^n. */
export const DEFAULT_BACKOFF_MS = [1000, 1500, 2250, 3375];
const CONTENT_TYPE = 'application/x-protobuf';
const MAX_BODY_CHARS = 256;

/** Why an export gave up: the last attempt's diagnostic and the attempt count. */
export class ExportFailure extends Error {
  constructor(readonly attempts: number, readonly detail: string) {
    super(attempts > 1 ? `${detail} (after ${attempts} attempts)` : detail);
    this.name = 'ExportFailure';
  }
}

class AttemptError extends Error {
  constructor(readonly retryable: boolean, readonly detail: string) {
    super(detail);
  }
}

/**
 * The endpoint must be an http(s) URL with a host - checked at start-up so a
 * misconfiguration surfaces before the first span.
 */
export function validateEndpoint(url: string): string {
  const trimmed = url.trim();
  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
    throw new Error(`${ENDPOINT}='${url}' must be an http(s) URL including the signal path, ` +
      'e.g. http://localhost:4318/v1/traces');
  }
  return trimmed;
}

/** The OTLP/HTTP exporter for one endpoint. */
export class Exporter {
  readonly endpoint: string;
  readonly serviceName: string;
  readonly scopeVersion: string;
  readonly compression: string;
  readonly timeoutMs: number;
  private readonly headers: () => Array<[string, string]>;
  private readonly backoffMs: number[];

  constructor(settings: ForwarderSettings, backoffMs: number[] = DEFAULT_BACKOFF_MS) {
    this.endpoint = validateEndpoint(settings.endpoint);
    this.serviceName = settings.serviceName;
    this.scopeVersion = settings.scopeVersion;
    this.compression = settings.compression;
    this.timeoutMs = settings.timeoutMs;
    this.headers = settings.headers;
    this.backoffMs = [...backoffMs];
  }

  /** The names of the request headers that resolve right now (values are never exposed). */
  headerNames(): string[] {
    return this.headers().map(([k]) => k);
  }

  /** The OTLP request body for one span. */
  encode(span: Span): Uint8Array {
    return encodeExportRequest(this.serviceName, INSTRUMENTATION_SCOPE, this.scopeVersion, span);
  }

  /**
   * Export one span, retrying transient failures on the backoff schedule; throws
   * `ExportFailure` when the attempts are exhausted or the backend's answer is final.
   */
  async export(span: Span): Promise<void> {
    const body = this.encode(span);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        await this.attempt(body);
        return;
      } catch (e) {
        const failure = e as AttemptError;
        if (failure.retryable && attempt <= this.backoffMs.length) {
          log.debug(`OTLP export attempt ${attempt} for span ${hex(span.spanId)} failed ` +
            `(${failure.detail}) - retrying`);
          await new Promise((resolve) => setTimeout(resolve, this.backoffMs[attempt - 1]).unref());
          continue;
        }
        throw new ExportFailure(attempt, failure.detail);
      }
    }
  }

  private async attempt(body: Uint8Array): Promise<void> {
    const headers: Record<string, string> = { 'content-type': CONTENT_TYPE, accept: CONTENT_TYPE };
    // headers are resolved per export, never baked in: a credential published
    // after start-up takes effect without a restart
    for (const [name, value] of this.headers()) {
      headers[name] = value;
    }
    let response: Response;
    let payload: Uint8Array;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST', headers, body: body as BodyInit,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      payload = new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      // the transport failed before an HTTP answer (fetch failed, timeout, TLS) -
      // retried like the Java exporter retries every IOException
      const error = e as Error & { cause?: { message?: string } };
      const detail = error.cause?.message ?? error.message ?? String(e);
      throw new AttemptError(true, detail);
    }
    classify(response.status, payload);
  }
}

function classify(status: number, payload: Uint8Array): void {
  if (status >= 200 && status < 300) {
    const partial = partialSuccess(payload);
    if (partial) {
      log.warn(`OTLP backend accepted the request but rejected ${partial.rejectedSpans} span(s) - ` +
        partial.errorMessage);
    }
    return;
  }
  const text = new TextDecoder('utf-8').decode(payload);
  throw new AttemptError(RETRYABLE_STATUSES.includes(status), describeHttpFailure(status, text));
}

/**
 * Render an HTTP rejection so it is actionable from one log line: the status, the
 * backend's own explanation (bounded), and a hint for the usual causes.
 */
export function describeHttpFailure(status: number, body: string): string {
  let text = `HTTP ${status}`;
  const collapsed = collapse(body);
  if (collapsed) text += ` - ${collapsed}`;
  const hint = HINTS[status];
  if (hint) text += ` | ${hint}`;
  return text;
}

const HINTS: Record<number, string> = {
  404: 'check otel.exporter.otlp.endpoint includes the signal path (e.g. .../v1/traces), ' +
    'not just the vendor base URL',
  401: 'the backend rejected the credential itself - check otel.exporter.otlp.headers (the ' +
    'header name and any auth scheme must match what the backend expects)',
  403: 'the credential was accepted but lacks permission - grant the trace-ingest scope on ' +
    'the token (the response body above names it)',
  413: 'the backend rejected the payload as too large',
  429: 'the backend is rate-limiting; the exporter retries with backoff'
};

function collapse(body: string): string {
  const collapsed = body.split(/\s+/).filter(Boolean).join(' ');
  return collapsed.length > MAX_BODY_CHARS ? `${collapsed.slice(0, MAX_BODY_CHARS)}...` : collapsed;
}

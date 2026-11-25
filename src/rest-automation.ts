/**
 * REST automation: `rest.yaml` served by the host (RFC-0018 in mercury-composable).
 *
 * With `rest.automation: true` the host reads one `yaml.rest.automation` location (default
 * `classpath:/rest.yaml`, read as `resources/rest.yaml` next to the application file under the pack's
 * resources rule; `file:` prefixes an absolute path) and serves its entries on the one server, beside
 * `POST /api/event` and the actuators, which become the engines' default entries so a user entry can
 * attach `authentication`, CORS or another timeout to them. The grammar, the keys, the messages and
 * the error body are the engines' - the pure half lives in `rest-routing.ts`, pinned by the shared
 * vector file; this module is the edge:
 *
 * - a request is matched to its entry (a known path under a wrong method is 405, the CORS preflight
 *   answers 204 with the `options` lines, no CORS block means 405 for `OPTIONS`);
 * - the entry's request transform applies, the trace is resolved (a W3C `traceparent` first, the
 *   trace-id header next, else a fresh id when `tracing` is on; the caller's span is the edge's
 *   parent), the correlation id is always ensured and echoed, and the entry's timeout rides the
 *   request as `x-ttl` in milliseconds unless the caller sent one;
 * - the function receives the whole request as the `AsyncHttpRequest` map, after the optional
 *   authentication function whose `true` verdict lets the request through and whose headers ride as
 *   the `session` map; its reply becomes the response with the engines' rules (a returned envelope
 *   sets the status and headers; a failure renders as the standard error body);
 * - `upload: true` on a POST entry reads a `multipart/form-data` body: each file arrives in the
 *   request map under the engines' keys (`filename`, `file_type`, `file_length`, the `upload` tags,
 *   `size`) with its bytes in `contents` - the pack's bounded form of the engines' streaming upload,
 *   within `rest.upload.max.bytes` (16 MiB; 413 beyond it) - and the form's text fields become query
 *   parameters;
 * - `stream: true` renders an interceptor's segments as Server-Sent Events or chunked text on the
 *   pack's reply sink; a traced call leaves the edge's `http.request` record and the function's
 *   round-trip record, as the engines do;
 * - a path no entry claims falls through to an extension's routes and then to the static folder,
 *   under the `static-content` rules - the `no-cache-pages` headers and the `filter` function.
 *
 * Off by default: with the switch off, the host is exactly what it was. No framework and no new
 * dependency: the edge is `node:http`, and a multipart body is parsed by the runtime's own `Response`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { appOrigin } from './actuator.js';
import { AsyncHttpRequest, UploadedFile } from './async-http-request.js';
import { DeliveryTimeout, EventBus, Mailbox, raceMs, roundTripRecord } from './bus.js';
import { AppConfig } from './config.js';
import { EventEnvelope, isoUtc } from './envelope.js';
import {
  CLIENT_GONE,
  DATA,
  EOF,
  EXCEPTION,
  keepAliveMs,
  nextSegment,
  sseFrame,
  streamEventName,
  streamSignal,
  X_EVENT_NAME,
  X_EVENT_STREAM,
  X_TTL
} from './event-stream.js';
import { AppException } from './exceptions.js';
import { getLogger } from './log.js';
import { FunctionRegistry, ServiceDef } from './registry.js';
import {
  AssignedRoute,
  baseContentType,
  compactJson,
  errorBody,
  errorPayload,
  mapResponse,
  matchedElement,
  negotiateStreamType,
  parseBody,
  parseCookies,
  parseQuery,
  parseYaml,
  ParsedBody,
  prettyJson,
  RouteInfo,
  RoutingTable,
  streamText,
  substituteValues
} from './rest-routing.js';
import type { EventApiServer } from './server.js';
import { MY_CID_TAG } from './trace.js';

const log = getLogger('mercury.rest');

export const REST_AUTOMATION = 'rest.automation';
export const YAML_REST_AUTOMATION = 'yaml.rest.automation';
export const DEFAULT_LOCATION = 'classpath:/rest.yaml';
export const TRACE_ID_HEADER = 'http.trace.id.header';
export const CORRELATION_ID_HEADER = 'http.correlation.id.header';
export const TRACEPARENT_HEADER = 'http.traceparent.header';
export const DEFAULT_TRACE_ID_HEADER = 'X-Trace-Id';
export const DEFAULT_CORRELATION_ID_HEADER = 'X-Correlation-Id';
const TRACEPARENT = 'traceparent';
// the bound on the files of one upload, all of them together (the pack's bounded form of the
// engines' streaming upload)
export const UPLOAD_MAX_BYTES = 'rest.upload.max.bytes';
export const DEFAULT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
// what the parts' boundaries and headers may add to a multipart body beyond the files it carries:
// a body past the bound plus this is refused before it is parsed, so the memory a request takes
// stays bounded as it is in the Python pack's part-by-part reading
const MULTIPART_HEADROOM = 1024 * 1024;
const MULTIPART_FORM_DATA = 'multipart/form-data';
// the edge's own service name in the trace records (the engines' REST edge)
export const HTTP_REQUEST = 'http.request';
export const EVENT_API_SERVICE = 'event.api.service';
// the engines' service names of the built-in endpoints, served by the host itself
export const ACTUATOR_SERVICES = ['info.actuator.service', 'routes.actuator.service', 'env.actuator.service',
  'health.actuator.service', 'liveness.actuator.service'] as const;
export const BUILT_IN_SERVICES: ReadonlySet<string> = new Set([EVENT_API_SERVICE, ...ACTUATOR_SERVICES]);
// the static-content filter's wait (the engines' FILTER_TIMEOUT)
const FILTER_TIMEOUT_MS = 10_000;
export const NO_CACHE_HEADERS: ReadonlyArray<[string, string]> = [
  ['Cache-Control', 'no-cache, no-store'], ['Pragma', 'no-cache'], ['Expires', 'Thu, 01 Jan 1970 00:00:00 GMT']
];
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const HEX = /^[0-9A-Fa-f]{2}$/;
// the percent-escapes a decoded query string keeps, so its structure survives a second parse - the
// Python pack's edge receives its query string this way (yarl's decoding)
const STRUCTURAL = new Set(['26', '3D', '2B']);

/** `rest.automation` is on - a boolean or the text `true`. */
export function enabled(config: AppConfig): boolean {
  const value = config.get(REST_AUTOMATION, false);
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/**
 * The file `yaml.rest.automation` names: `classpath:` is the `resources` folder, `file:` an absolute
 * path, a relative path is under the application file's folder; undefined when the application file
 * is unknown (an interactive session).
 */
export function resolveLocation(config: AppConfig, location: string): string | undefined {
  let value = location.trim();
  if (value.startsWith('classpath:')) {
    if (config.resourcesDir === undefined) {
      return undefined;
    }
    return join(config.resourcesDir, value.slice('classpath:'.length).replace(/^\/+/, ''));
  }
  if (value.startsWith('file:')) {
    value = value.slice('file:'.length);
  }
  if (isAbsolute(value)) {
    return value;
  }
  if (config.appDir === undefined) {
    return undefined;
  }
  return join(config.appDir, value);
}

function isFile(path: string): boolean {
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The routing table: the file's entries (`${ENV:default}` resolved in every value) plus the engines'
 * default endpoints the file does not claim. A missing or empty file degrades to the defaults with a
 * warning, as in the engines; an invalid entry fails the load.
 */
export function loadTable(config: AppConfig): RoutingTable {
  let location = config.getProperty(YAML_REST_AUTOMATION, DEFAULT_LOCATION) || DEFAULT_LOCATION;
  if (location.includes(',')) {
    // the Java engine merges several locations; this pack, like the Rust port, reads one
    log.warn(`${YAML_REST_AUTOMATION} names several locations - this pack reads the first`);
    location = location.split(',', 1)[0];
  }
  const path = resolveLocation(config, location);
  let table = new RoutingTable();
  if (path === undefined || !isFile(path)) {
    log.warn(`REST automation configuration not found - ${location} (the default endpoints only)`);
  } else {
    const data = parseYaml(fs.readFileSync(path, 'utf-8'));
    if (data === null || data === undefined) {
      log.warn(`REST automation configuration is empty - ${path} (the default endpoints only)`);
    } else {
      table = RoutingTable.load(substituteValues(data, (value) => config.resolveText(value)));
      log.info(`Loading REST automation from ${path}`);
    }
  }
  table.mergeDefaults();
  return table;
}

/** A well-formed W3C traceparent as `[trace id, parent span]`. */
export function parseTraceparent(value: string | undefined): [string, string] | undefined {
  const match = TRACEPARENT_RE.exec((value ?? '').trim().toLowerCase());
  return match ? [match[1], match[2]] : undefined;
}

/** A percent-encoded text decoded to UTF-8, with the escapes named kept as written. */
function percentDecode(value: string, keep: ReadonlySet<string>): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const hex = value.slice(i + 1, i + 3);
    if (char === '%' && HEX.test(hex) && !keep.has(hex.toUpperCase())) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...encoder.encode(char));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** The request path as the Python edge sees it: percent-escapes decoded. */
export function decodePath(pathname: string): string {
  return percentDecode(pathname, new Set());
}

/**
 * The query string as the Python edge receives it: `+` a space and the escapes decoded, except the
 * ones that would change the structure (`&`, `=`, `+`) - every pair still parses the same way.
 */
export function decodeQueryString(search: string): string {
  return percentDecode(search.replaceAll('+', ' '), STRUCTURAL);
}

/** The engines' error shape on the wire, with the header as they send it - a bare `application/json`. */
export function restError(res: http.ServerResponse, status: number, message: string): void {
  const bytes = errorPayload(status, message);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

function streamErrorMessage(event: EventEnvelope): string {
  const body = event.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && !(body instanceof Uint8Array)) {
    const message = (body as Record<string, unknown>).message;
    return message !== null && message !== undefined ? streamText(message) : 'Stream failed';
  }
  if (body === null || body === undefined) {
    return 'Stream failed';
  }
  return streamText(body);
}

function chunkBytes(body: unknown): Buffer {
  if (body === null || body === undefined) {
    return Buffer.alloc(0);
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf-8');
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(`${compactJson(body)}\n`, 'utf-8');
}

/** A reply's body as an HTTP payload with its own content type - the filter pass-through. */
export function envelopePayload(reply: EventEnvelope): [string | undefined, Buffer] {
  const body = reply.body;
  if (body === null || body === undefined) {
    return [undefined, Buffer.alloc(0)];
  }
  if (typeof body === 'string') {
    return ['text/plain', Buffer.from(body, 'utf-8')];
  }
  if (body instanceof Uint8Array) {
    return ['application/octet-stream', Buffer.from(body)];
  }
  return ['application/json', Buffer.from(prettyJson(body), 'utf-8')];
}

function requestHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return headers;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const uuidHex = (): string => randomUUID().replaceAll('-', '');

/**
 * The trace records of one traced call through a REST entry - what the engines leave: the edge's
 * `http.request` round trip (the SERVER span, parented onto the caller's span from the traceparent)
 * and, for an RPC, the function's round-trip record parented onto the edge.
 */
class RestEdge {
  readonly edgeSpan = randomBytes(8).toString('hex');
  private readonly start = isoUtc();
  private readonly started = process.hrtime.bigint();

  constructor(private readonly bus: EventBus, readonly traceId: string, readonly tracePath: string,
              private readonly callerSpan: string | undefined) {}

  private elapsed(): number {
    return Math.round(Number(process.hrtime.bigint() - this.started) / 1000) / 1000;
  }

  recordFunction(service: string, reply: EventEnvelope, dispatched: string, started: bigint): void {
    this.bus.emit(roundTripRecord({
      service, sender: HTTP_REQUEST, traceId: this.traceId, tracePath: this.tracePath, reply,
      parentSpanId: this.edgeSpan, start: dispatched,
      roundTripMs: Number(process.hrtime.bigint() - started) / 1e6
    }), reply.annotations);
  }

  record(status: number, error?: string): void {
    const trace: Record<string, unknown> = {
      origin: appOrigin(), id: this.traceId, path: this.tracePath, service: HTTP_REQUEST, start: this.start,
      exec_time: this.elapsed(), status, success: status < 400, span_id: this.edgeSpan
    };
    if (this.callerSpan) {
      trace.parent_span_id = this.callerSpan;
    }
    if (status >= 400 && error) {
      trace.exception = error;
    }
    this.bus.emit(trace);
  }
}

/** One request, prepared for its entry: the request model, the resolved ids and the context the response needs. */
interface Prepared {
  httpRequest: AsyncHttpRequest;
  cid: string;
  cidHeader: string;
  traceId?: string;
  tracePath: string;
  accept?: string;
  edge?: RestEdge;
  isHead: boolean;
  /** the body as it arrived - what the built-in Event API service decodes */
  raw: Buffer;
}

/** A race against a timer whose loser is left to finish quietly. */
async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  work.catch(() => {}); // a handler that fails after the deadline has nobody waiting for it
  return raceMs(work, timeoutMs);
}

/** The REST automation edge of one host. */
export class RestAutomation {
  readonly registry: FunctionRegistry;
  private readonly bus: EventBus;
  private readonly traceHeader: string;
  private readonly cidHeader: string;
  private readonly traceparentHeader: string;
  private readonly uploadMaxBytes: number;
  private started = false;

  constructor(readonly table: RoutingTable, config: AppConfig, private readonly server: EventApiServer) {
    this.registry = server.registry;
    this.bus = server.registry.bus;
    this.traceHeader = (config.getProperty(TRACE_ID_HEADER, DEFAULT_TRACE_ID_HEADER) || DEFAULT_TRACE_ID_HEADER).toLowerCase();
    this.cidHeader = (config.getProperty(CORRELATION_ID_HEADER, DEFAULT_CORRELATION_ID_HEADER)
      || DEFAULT_CORRELATION_ID_HEADER).toLowerCase();
    this.traceparentHeader = (config.getProperty(TRACEPARENT_HEADER, TRACEPARENT) || TRACEPARENT).toLowerCase();
    const bound = Number.parseInt(String(config.get(UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES)), 10);
    this.uploadMaxBytes = Number.isFinite(bound) ? bound : DEFAULT_UPLOAD_MAX_BYTES;
  }

  /** The edge when `rest.automation` is on, else undefined. */
  static load(config: AppConfig, server: EventApiServer): RestAutomation | undefined {
    if (!enabled(config)) {
      return undefined;
    }
    return new RestAutomation(loadTable(config), config, server);
  }

  /**
   * Drop the entries whose service is not registered (the engines' load-time rule, run at the end of
   * the boot so an extension's startup registrations count) and announce the table.
   */
  startup(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const skipped = this.table.retainAvailable(
      (service) => BUILT_IN_SERVICES.has(service) || this.registry.exists(service));
    for (const [methods, url, service] of skipped) {
      log.warn(`Skip ${methods} ${url} - Service ${service} not available`);
    }
    for (const route of this.table.routes) {
      log.info(`REST [${route.methods.join(', ')}] ${route.url} -> ${route.service}`);
    }
    const filter = this.table.staticContent.filter;
    if (filter !== undefined && !this.registry.exists(filter.service)) {
      log.warn(`Static content filter ${filter.service} ignored because it does not exist`);
    }
  }

  // ---- the edge ----

  /**
   * Serve the request when an entry claims its path: true once the response is taken - an entry's
   * function, a built-in service, the preflight, or the 405 of a known path under another method.
   * False leaves the path to the host: an extension's routes, then the static folder under the
   * `static-content` rules (`serveStatic`), then the engines' 404.
   */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const method = (req.method ?? 'GET').toUpperCase();
    const path = decodePath(url.pathname);
    let assigned = this.table.find(method, path);
    if (assigned === undefined && path === '/') {
      // the engines: a request for exactly "/" falls back to a declared /index.html entry
      assigned = this.table.find(method, '/index.html');
    }
    if (assigned === undefined) {
      if (this.table.pathMatchesAnyMethod(path)) {
        restError(res, 405, 'Method not allowed');
        return true;
      }
      return false;
    }
    if (method === 'OPTIONS') {
      RestAutomation.preflight(res, assigned.info);
      return true;
    }
    if (BUILT_IN_SERVICES.has(assigned.info.service)) {
      await this.builtin(req, res, url, assigned);
    } else {
      await this.process(req, res, url, assigned);
    }
    return true;
  }

  /** The CORS preflight: the `options` lines with 204; no CORS block means 405. */
  private static preflight(res: http.ServerResponse, info: RouteInfo): void {
    if (info.cors === undefined || !info.cors.options.length) {
      restError(res, 405, 'Method not allowed');
      return;
    }
    for (const [name, value] of info.cors.options) {
      res.setHeader(name, value);
    }
    res.writeHead(204);
    res.end();
  }

  /**
   * The engines' ingress: the request transform, the trace and correlation ids, the `x-ttl` stamp,
   * and the request model built from the method, path, query, cookies and the body parsed by its
   * content type.
   */
  private async prepare(req: http.IncomingMessage, url: URL, assigned: AssignedRoute): Promise<Prepared> {
    const info = assigned.info;
    const method = (req.method ?? 'GET').toUpperCase();
    const path = decodePath(url.pathname);
    let headers = requestHeaders(req);
    if (info.headers !== undefined) {
      headers = info.headers.request.apply(headers);
    }
    const traceHeader = (info.traceIdHeader ?? this.traceHeader).toLowerCase();
    const cidHeader = (info.correlationIdHeader ?? this.cidHeader).toLowerCase();
    // a well-formed standard traceparent wins; the custom name is read only when it is absent
    let traceparent = parseTraceparent(headers[TRACEPARENT]);
    if (traceparent === undefined) {
      const custom = (info.traceparentHeader ?? this.traceparentHeader).toLowerCase();
      if (custom !== TRACEPARENT) {
        traceparent = parseTraceparent(headers[custom]);
      }
    }
    let traceId: string | undefined;
    let parentSpan: string | undefined;
    if (traceparent !== undefined) {
      [traceId, parentSpan] = traceparent;
    } else {
      traceId = headers[traceHeader];
    }
    traceId = info.tracing ? (traceId || uuidHex()) : undefined;
    // a business correlation id is always ensured; one header name serving both roles yields one
    // id, not two
    let cid = headers[cidHeader];
    if (!cid) {
      cid = cidHeader === traceHeader && traceId ? traceId : uuidHex();
    }
    headers[cidHeader] = cid;
    headers[X_TTL] ??= String(info.timeoutSeconds * 1000);
    const queryText = decodeQueryString(url.search.startsWith('?') ? url.search.slice(1) : url.search);
    const query = parseQuery(queryText);
    const cookies = parseCookies(headers.cookie);
    delete headers.cookie;
    const accept = headers.accept;
    let files: UploadedFile[] = [];
    let parsed: ParsedBody;
    let raw: Buffer = Buffer.alloc(0);
    const declared = (baseContentType(headers['content-type']) ?? '').toLowerCase();
    if (info.upload && method === 'POST' && declared === MULTIPART_FORM_DATA) {
      // the engines' upload, bounded: the files' bytes ride the request map, a form's text fields
      // become query parameters, the body stays absent
      const read = await this.readMultipart(req);
      files = read.files;
      for (const [name, value] of Object.entries(read.fields)) {
        query[name] = value;
      }
      parsed = { kind: 'upload', value: null };
    } else {
      raw = await readBody(req);
      parsed = parseBody(headers['content-type'], raw);
      if (parsed.kind === 'form') {
        for (const [name, value] of Object.entries(parsed.value as Record<string, string>)) {
          query[name] = value;
        }
      }
    }
    const httpRequest = new AsyncHttpRequest().setMethod(method).setUrl(path)
      .setRemoteIp(req.socket?.remoteAddress ?? 'unknown')
      .setSecure(headers['x-forwarded-proto'] === 'https')
      .setTargetHost(headers.host ?? '')
      .setTimeoutSeconds(info.timeoutSeconds);
    for (const [name, value] of Object.entries(headers)) {
      httpRequest.setHeader(name, value);
    }
    for (const [name, value] of Object.entries(assigned.pathParams)) {
      httpRequest.setPathParameter(name, value);
    }
    for (const [name, value] of Object.entries(query)) {
      httpRequest.setQueryParameter(name, value);
    }
    if (parsed.kind === 'upload') {
      for (const uploaded of files) {
        httpRequest.addFile(uploaded.name, uploaded.contentType, uploaded.content, uploaded.tag);
      }
    } else {
      httpRequest.setBody(parsed.kind === 'form' ? null : parsed.value);
    }
    if (queryText) {
      httpRequest.setQueryString(queryText);
    }
    for (const [name, value] of Object.entries(cookies)) {
      httpRequest.setCookie(name, value);
    }
    const tracePath = queryText ? `${method} ${path}?${queryText}` : `${method} ${path}`;
    const edge = traceId ? new RestEdge(this.bus, traceId, tracePath, parentSpan) : undefined;
    return { httpRequest, cid, cidHeader, traceId, tracePath, accept, edge, isHead: method === 'HEAD', raw };
  }

  /**
   * The parts of a multipart body: a part with a filename is a file (its field name the upload tag,
   * its declared type or octet-stream), any other part a text field. The files together may not
   * exceed `rest.upload.max.bytes` - a 413 the moment they do.
   */
  private async readMultipart(req: http.IncomingMessage): Promise<{ files: UploadedFile[]; fields: Record<string, string> }> {
    const files: UploadedFile[] = [];
    const fields: Record<string, string> = {};
    const bound = this.uploadMaxBytes;
    const exceeded = (): AppException => new AppException(413, `Upload exceeds ${bound} bytes`);
    let refused: AppException | undefined;
    const cap = bound + MULTIPART_HEADROOM;
    async function* capped(): AsyncGenerator<Buffer> {
      let seen = 0;
      for await (const chunk of req) {
        seen += (chunk as Buffer).length;
        if (seen > cap) {
          refused = exceeded();
          throw refused;
        }
        yield chunk as Buffer;
      }
    }
    let form: FormData;
    try {
      const body = Readable.toWeb(Readable.from(capped())) as ReadableStream<Uint8Array>;
      const headers = { 'content-type': String(req.headers['content-type']) };
      form = await new Response(body, { headers }).formData();
    } catch (e) {
      if (refused) {
        throw refused;
      }
      throw new AppException(400, `Invalid multipart body - ${(e as Error).message ?? String(e)}`);
    }
    let total = 0;
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        total += value.length;
        if (total > bound) {
          throw exceeded();
        }
        fields[name] = value;
        continue;
      }
      const content = Buffer.from(await value.arrayBuffer());
      total += content.length;
      if (total > bound) {
        throw exceeded();
      }
      files.push({
        name: value.name, contentType: value.type || 'application/octet-stream', size: content.length,
        tag: name || 'file', content
      });
    }
    return { files, fields };
  }

  /**
   * The event a function (or the authentication function) receives: the request map as the body,
   * the edge as the sender, the correlation id as the engine-managed tag, and under a trace the
   * edge's span as the parent.
   */
  private static event(to: string, prepared: Prepared): EventEnvelope {
    const event = new EventEnvelope(to, prepared.httpRequest.toMap());
    event.setFrom(HTTP_REQUEST);
    event.setCorrelationId(prepared.cid);
    event.tags[MY_CID_TAG] = prepared.cid;
    if (prepared.traceId) {
      event.setTrace(prepared.traceId, prepared.tracePath);
      if (prepared.edge !== undefined) {
        event.setSpanId(prepared.edge.edgeSpan);
      }
    }
    return event;
  }

  /** One RPC to a function through the bus, recorded on the edge under a trace. */
  private async rpc(route: string, service: ServiceDef, prepared: Prepared, timeoutMs: number): Promise<EventEnvelope> {
    const event = RestAutomation.event(route, prepared);
    const dispatched = isoUtc();
    const started = process.hrtime.bigint();
    let reply: EventEnvelope;
    try {
      reply = await this.bus.deliver(service, {}, event.body, timeoutMs, {
        traceId: prepared.traceId, tracePath: prepared.tracePath, cid: prepared.cid, envelope: event
      });
    } catch (e) {
      if (!(e instanceof DeliveryTimeout)) {
        throw e;
      }
      const message = `Timeout for ${timeoutMs} ms`;
      if (prepared.edge !== undefined) {
        const timeout = new EventEnvelope().setStatus(408).setBody(message);
        prepared.edge.recordFunction(route, timeout, dispatched, started);
      }
      throw new AppException(408, message);
    }
    prepared.edge?.recordFunction(route, reply, dispatched, started);
    return reply;
  }

  /**
   * The optional authentication function: `true` lets the request through, anything else is 401,
   * an error is its own status; the verdict's headers become the session map.
   */
  private async authenticate(info: RouteInfo, prepared: Prepared): Promise<void> {
    const route = info.authentication ?? '';
    const service = this.registry.get(route);
    if (service === undefined) {
      throw new AppException(503, `Service ${route} not reachable`);
    }
    const verdict = await this.rpc(route, service, prepared, info.timeoutMs);
    if (verdict.hasError()) {
      const message = typeof verdict.body === 'string' ? verdict.body : 'Unauthorized';
      throw new AppException(verdict.getStatus(), message);
    }
    if (verdict.body !== true) {
      throw new AppException(401, 'Unauthorized');
    }
    for (const [name, value] of Object.entries(verdict.headers)) {
      prepared.httpRequest.setSessionInfo(name, value);
    }
  }

  /**
   * Send to an interceptor with a reply sink and take its first valid envelope; the sink route is
   * returned for the caller to close.
   */
  private async firstReply(service: ServiceDef, event: EventEnvelope, timeoutMs: number):
      Promise<{ first: EventEnvelope; marker: string | undefined; sinkRoute: string; queue: Mailbox<EventEnvelope> }> {
    const [sinkRoute, queue] = this.bus.openSink();
    event.setReplyTo(sinkRoute);
    this.bus.publishEnvelope(service, event);
    for (;;) {
      const first = await raceMs(queue.next(), timeoutMs);
      if (!first) {
        this.bus.closeSink(sinkRoute);
        throw new AppException(408, `Timeout for ${timeoutMs} ms`);
      }
      const marker = streamSignal(first);
      if (marker === undefined || marker === DATA || marker === EOF || marker === EXCEPTION) {
        return { first, marker, sinkRoute, queue };
      }
      log.warn(`Dropping event - invalid ${X_EVENT_STREAM} signal`);
    }
  }

  private async process(req: http.IncomingMessage, res: http.ServerResponse, url: URL,
                        assigned: AssignedRoute): Promise<void> {
    const info = assigned.info;
    let prepared: Prepared;
    try {
      prepared = await this.prepare(req, url, assigned);
    } catch (e) {
      if (e instanceof AppException) {
        restError(res, e.status, e.message);
        return;
      }
      throw e;
    }
    const edge = prepared.edge;
    let reply: EventEnvelope;
    try {
      if (info.authentication) {
        await this.authenticate(info, prepared);
      }
      const service = this.registry.get(info.service);
      if (service === undefined) {
        throw new AppException(503, `Service ${info.service} not reachable`);
      }
      if (service.interceptor) {
        const event = RestAutomation.event(info.service, prepared);
        const { first, marker, sinkRoute, queue } = await this.firstReply(service, event, info.timeoutMs);
        if (marker !== undefined && info.stream && !prepared.isHead) {
          // the multi-shot reply: the first segment commits the head, the renderer owns the
          // round-trip record from here
          await this.stream(res, info, prepared, first, marker, sinkRoute, queue);
          return;
        }
        this.bus.closeSink(sinkRoute);
        if (marker === EXCEPTION) {
          const status = first.hasError() ? first.getStatus() : 500;
          throw new AppException(status, streamErrorMessage(first));
        }
        // a single-shot reply (a marked segment taken as the whole reply - the first event
        // completes the exchange, the engines' rule)
        const kept: Record<string, string> = {};
        for (const [name, value] of Object.entries(first.headers)) {
          const key = name.toLowerCase();
          if (key !== X_EVENT_STREAM && key !== X_EVENT_NAME) {
            kept[name] = value;
          }
        }
        first.headers = kept;
        reply = first;
      } else {
        reply = await this.rpc(info.service, service, prepared, info.timeoutMs);
      }
    } catch (e) {
      if (e instanceof AppException) {
        edge?.record(e.status, e.message);
        restError(res, e.status, e.message);
        return;
      }
      throw e;
    }
    const mapped = mapResponse({
      status: reply.getStatus(), replyHeaders: reply.headers, body: reply.body, accept: prepared.accept,
      isHead: prepared.isHead, transform: info.headers?.response, cors: info.cors, cid: prepared.cid,
      cidHeader: prepared.cidHeader
    });
    const cookies: string[] = [];
    for (const [name, value] of mapped.headers) {
      if (name === 'set-cookie') {
        cookies.push(value);
      } else {
        res.setHeader(name, value);
      }
    }
    if (cookies.length) {
      res.setHeader('set-cookie', cookies);
    }
    res.setHeader('content-length', mapped.body.length);
    res.writeHead(mapped.status);
    res.end(mapped.body);
    edge?.record(mapped.status);
  }

  /**
   * Render an interceptor's segments progressively: Server-Sent Events when the head or the
   * negotiation says `text/event-stream`, chunked text or JSON lines otherwise; the stream ends at
   * `eof`, fails in band at an `exception` or when the producer idles past the allowance (the
   * entry's timeout, or the head's `x-ttl` in seconds).
   */
  private async stream(res: http.ServerResponse, info: RouteInfo, prepared: Prepared, first: EventEnvelope,
                       marker: string, sinkRoute: string, queue: Mailbox<EventEnvelope>): Promise<void> {
    let headers: Record<string, string> = {};
    const cookies: string[] = [];
    let contentType: string | undefined;
    let idleMs = info.timeoutMs;
    for (const [name, value] of Object.entries(first.headers)) {
      const key = name.toLowerCase();
      if (key === X_EVENT_STREAM || key === X_EVENT_NAME || key === 'x-stream-id') {
        continue;
      }
      if (key === X_TTL) {
        const seconds = Number.parseInt(value.trim(), 10);
        if (Number.isFinite(seconds) && seconds > 0) {
          idleMs = seconds * 1000;
        }
      } else if (key === 'content-type') {
        contentType = value.toLowerCase();
      } else if (key === 'set-cookie') {
        cookies.push(...value.split('|').map((c) => c.trim()).filter((c) => c.length > 0));
      } else {
        headers[key] = value;
      }
    }
    if (info.headers !== undefined) {
      headers = info.headers.response.apply(headers);
    }
    if (!Object.keys(headers).some((name) => name.toLowerCase() === prepared.cidHeader)) {
      headers[prepared.cidHeader] = prepared.cid;
    }
    if (info.cors !== undefined) {
      for (const [name, value] of info.cors.headers) {
        headers[name.toLowerCase()] = value;
      }
    }
    contentType ||= negotiateStreamType(prepared.accept);
    const sse = contentType.startsWith('text/event-stream');
    if (sse) {
      headers['cache-control'] ??= 'no-cache';
    }
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    if (cookies.length) {
      res.setHeader('set-cookie', cookies);
    }
    res.setHeader('content-type', contentType);
    res.writeHead(first.getStatus());
    let status = first.getStatus();
    let error: string | undefined;
    try {
      [status, error] = await this.render(res, queue, first, marker, sse, idleMs);
    } finally {
      this.bus.closeSink(sinkRoute);
    }
    if (!res.writableEnded) {
      res.end();
    }
    prepared.edge?.record(status, error);
  }

  /** The frames until the terminal; returns the stream's outcome for the edge's record. */
  private async render(res: http.ServerResponse, queue: Mailbox<EventEnvelope>, first: EventEnvelope,
                       firstMarker: string, sse: boolean, idleMs: number): Promise<[number, string | undefined]> {
    let pending: { event: EventEnvelope; marker: string } | undefined = { event: first, marker: firstMarker };
    const headStatus = first.getStatus();
    const pingMs = sse ? keepAliveMs() : 0;
    for (;;) {
      if (res.writableEnded || res.destroyed) {
        log.debug('Client disconnected from event stream');
        return [headStatus, undefined];
      }
      let event: EventEnvelope;
      let marker: string;
      if (pending !== undefined) {
        ({ event, marker } = pending);
        pending = undefined;
      } else {
        const waited = await nextSegment(res, queue, idleMs, pingMs);
        if (waited === CLIENT_GONE) {
          // a keep-alive that cannot be written means the client is gone: the stream ends here and
          // the caller closes the sink, instead of waiting out the idle allowance
          log.debug('Client disconnected from event stream');
          return [headStatus, undefined];
        }
        if (!waited) {
          const seconds = Math.trunc(idleMs / 1000);
          const message = `Timeout for ${seconds} seconds`;
          if (sse) {
            res.write(sseFrame('error', compactJson(errorBody(408, message))));
          }
          return [408, message];
        }
        const found = streamSignal(waited);
        if (found === undefined) {
          log.warn('Single-shot reply dropped - its streaming response has already started');
          continue;
        }
        if (found !== DATA && found !== EOF && found !== EXCEPTION) {
          log.warn(`Dropping event - invalid ${X_EVENT_STREAM} signal`);
          continue;
        }
        event = waited;
        marker = found;
      }
      if (marker === DATA) {
        if (sse) {
          if (event.body !== null && event.body !== undefined) {
            res.write(sseFrame(streamEventName(event), streamText(event.body)));
          }
        } else {
          const chunk = chunkBytes(event.body);
          if (chunk.length) {
            res.write(chunk);
          }
        }
      } else if (marker === EOF) {
        if (sse) {
          const body = event.body !== null && event.body !== undefined ? streamText(event.body) : '{}';
          res.write(sseFrame('done', body));
        }
        return [headStatus, undefined];
      } else {
        const status = event.hasError() ? event.getStatus() : 500;
        const message = streamErrorMessage(event);
        if (sse) {
          res.write(sseFrame('error', compactJson(errorBody(status, message))));
        }
        return [status, message];
      }
    }
  }

  // ---- the built-in endpoints and static content ----

  /**
   * A default entry, or a user entry naming a built-in service: the host's own handler, behind the
   * entry's authentication, within its timeout (a caller's `x-ttl` wins), with the entry's CORS
   * headers and added response headers.
   */
  private async builtin(req: http.IncomingMessage, res: http.ServerResponse, url: URL,
                        assigned: AssignedRoute): Promise<void> {
    const info = assigned.info;
    let prepared: Prepared;
    try {
      prepared = await this.prepare(req, url, assigned);
      if (info.authentication) {
        await this.authenticate(info, prepared);
      }
    } catch (e) {
      if (e instanceof AppException) {
        restError(res, e.status, e.message);
        return;
      }
      throw e;
    }
    let ttlMs = info.timeoutMs;
    const header = req.headers[X_TTL];
    if (header !== undefined) {
      const sent = Number.parseInt(String(header).trim(), 10);
      if (Number.isFinite(sent)) {
        ttlMs = Math.max(1000, sent);
      }
    }
    // the host writes the response itself, so the entry's headers are set ahead of it
    if (info.cors !== undefined) {
      for (const [name, value] of info.cors.headers) {
        res.setHeader(name, value);
      }
    }
    if (info.headers !== undefined) {
      for (const [name, value] of info.headers.response.add) {
        res.setHeader(name, value);
      }
    }
    if (info.service === EVENT_API_SERVICE) {
      // the Event API service bounds its own execution with the event's x-ttl
      await this.server.handleEvent(req, res, prepared.raw);
      return;
    }
    const served = await within(this.server.actuator.byService(info.service, res), ttlMs);
    if (served === null) {
      if (!res.headersSent) {
        restError(res, 408, `Timeout for ${ttlMs} ms`);
      }
    } else if (!served) {
      restError(res, 404, 'Resource not found');
    }
  }

  /**
   * A static file under the `static-content` rules: the filter function first (its headers ride the
   * response; a status other than 200 passes its reply through), then the file with the no-cache
   * headers for an entry page, else the host's ETag service. False when the path names no file.
   */
  async serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const files = this.server.files;
    if (!files.enabled) {
      return false;
    }
    const file = await files.locate(url.pathname);
    if (file === undefined) {
      return false;
    }
    const path = decodePath(url.pathname);
    const config = this.table.staticContent;
    const extra: Record<string, string> = {};
    const filter = config.filter;
    if (filter !== undefined && matchedElement(filter.pathList, path) && !matchedElement(filter.exclusionList, path)) {
      const service = this.registry.get(filter.service);
      if (service === undefined) {
        log.warn(`Static content filter ${filter.service} ignored because it does not exist`);
      } else {
        try {
          const filtered = await this.runFilter(req, url, service, path);
          Object.assign(extra, filtered.headers);
          if (filtered.getStatus() !== 200) {
            const [kind, payload] = envelopePayload(filtered);
            for (const [name, value] of Object.entries(filtered.headers)) {
              res.setHeader(name, value);
            }
            if (kind !== undefined && !res.hasHeader('content-type')) {
              res.setHeader('content-type', kind);
            }
            res.setHeader('content-length', payload.length);
            res.writeHead(filtered.getStatus());
            res.end(payload);
            return true;
          }
        } catch (e) {
          if (!(e instanceof AppException || e instanceof DeliveryTimeout)) {
            throw e;
          }
          // the Rust port's resilient divergence: log and serve the file anyway
          log.error(`Unable to filter static content HTTP-GET ${filter.service} - ${e.message}`);
        }
      }
    }
    if (matchedElement(config.noCachePages, path)) {
      for (const [name, value] of NO_CACHE_HEADERS) {
        extra[name] = value;
      }
    }
    return files.serve(req, res, url.pathname, extra);
  }

  /** The filter receives an `AsyncHttpRequest`-shaped event without a body. */
  private runFilter(req: http.IncomingMessage, url: URL, service: ServiceDef, path: string): Promise<EventEnvelope> {
    const headers = requestHeaders(req);
    const httpRequest = new AsyncHttpRequest().setMethod('GET').setUrl(path)
      .setRemoteIp(req.socket?.remoteAddress ?? 'unknown').setSecure(false)
      .setTargetHost(headers.host ?? '').setBody(null);
    for (const [name, value] of Object.entries(headers)) {
      httpRequest.setHeader(name, value);
    }
    const queryText = decodeQueryString(url.search.startsWith('?') ? url.search.slice(1) : url.search);
    for (const [name, value] of Object.entries(parseQuery(queryText))) {
      httpRequest.setQueryParameter(name, value);
    }
    const event = new EventEnvelope(service.route, httpRequest.toMap());
    return this.bus.deliver(service, {}, event.body, FILTER_TIMEOUT_MS, { envelope: event });
  }
}

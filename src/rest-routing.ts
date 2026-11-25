/**
 * REST automation, the pure half: the routing table `rest.yaml` declares and the rules of the HTTP
 * edge that need no server - the engines' grammar, keys, messages and error body, never a pack
 * dialect (RFC-0018 in mercury-composable).
 *
 * `rest.yaml` is the router: an entry maps a URL and its methods to a composable function, with CORS,
 * header transforms, an authentication function, a timeout, tracing and static content. This module
 * mirrors the Rust engine's `automation/routing.rs` and the pure rules of its `automation/server.rs`
 * (the Java `RoutingEntry`, `HttpRouter` and `AsyncHttpResponse`): the parser with its load-time
 * refusals, the URL matching with its precedence, the header transforms, the request-body dispatch by
 * content type, the `Accept` negotiation, the payload rendering and the mapping of a reply envelope to
 * an HTTP response. Everything here is pinned by the shared vector file
 * `test/vectors/rest-automation-vectors.json`, byte-identical with the Python pack.
 *
 * What a pack refuses by name, so the grammar itself shows the scope fence: a `flow` binding (`flow:`
 * or `service: http.flow.adapter` - flows run in the engines), the HTTP relay (an `http(s)://`
 * service) and the A/B dual service (a list of two routes). `upload: true` is the pack's bounded form
 * of the engines' streaming upload: the files arrive in the request map, their bytes beside the
 * engines' keys, within `rest.upload.max.bytes`. Deferred as in the Rust port: `custom.content.types`,
 * `mime.types`, XML and request-body streaming.
 */
import YAML from 'yaml';
import { asText } from './envelope.js';
import { AppException } from './exceptions.js';

export const ALLOWED_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'PATCH'] as const;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;
export const FLOW_ADAPTER = 'http.flow.adapter';
// the engines' built-in default endpoints (platform-core's default-rest.yaml): merged only when the
// application's rest.yaml does not already claim the URL - a user entry always wins
export const DEFAULT_REST_YAML = `
rest:
  - service: "event.api.service"
    methods: ['POST']
    url: "/api/event"
    timeout: 60s
    tracing: true
  - service: "info.actuator.service"
    methods: ['GET']
    url: "/info"
    timeout: 10s
  - service: "routes.actuator.service"
    methods: ['GET']
    url: "/info/routes"
    timeout: 10s
  - service: "env.actuator.service"
    methods: ['GET']
    url: "/env"
    timeout: 10s
  - service: "health.actuator.service"
    methods: ['GET']
    url: "/health"
    timeout: 30s
  - service: "liveness.actuator.service"
    methods: ['GET']
    url: "/livenessprobe"
    timeout: 10s
`;
// the reserved envelope metadata that never reaches the HTTP wire (the engines' protected metadata:
// the my_* keys of the worker's header view)
const PROTECTED_PREFIX = 'my_';
export const HTML_START = '<html><body><pre>\n';
export const HTML_END = '\n</pre></body></html>';

type Pair = [string, string];

export type Mapping = Record<string, unknown>;

/** A plain map - a YAML mapping, a decoded MsgPack map; never a list, a buffer or a scalar. */
export function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Python's int() over text: an optional sign and decimal digits, surrounding blanks allowed. */
function integer(value: string): number | undefined {
  const trimmed = value.trim();
  return /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
}

/**
 * A duration like `30s`, `2m`, `1500ms` or a bare number of seconds, in milliseconds; the default
 * 30 s when unparsable, clamped to 1 s - 5 min (the engines' rule).
 */
export function parseTimeout(value: unknown): number {
  let parsed: number | undefined;
  if (typeof value === 'boolean') {
    parsed = undefined;
  } else if (typeof value === 'number') {
    parsed = Number.isFinite(value) ? Math.trunc(value) * 1000 : undefined;
  } else if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    let scale = 1000;
    let digits = lowered;
    if (lowered.endsWith('ms')) {
      scale = 1;
      digits = lowered.slice(0, -2);
    } else if (lowered.endsWith('m')) {
      scale = 60_000;
      digits = lowered.slice(0, -1);
    } else if (lowered.endsWith('s')) {
      digits = lowered.slice(0, -1);
    }
    const number = integer(digits);
    parsed = number === undefined ? undefined : number * scale;
  }
  if (parsed === undefined || parsed < 0) {
    parsed = DEFAULT_TIMEOUT_MS;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, parsed));
}

function without(headers: Record<string, string>, lowered: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== lowered) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * A request or response transform of a `headers` block: `keep` retains only the listed names (and
 * takes precedence over `drop`, which is then ignored - the Java engine's rule), else `drop` removes
 * the listed names; then `add` inserts - names matched case-insensitively.
 */
export class HeaderTransform {
  constructor(readonly add: Pair[] = [], readonly drop: string[] = [], readonly keep: string[] = []) {}

  apply(headers: Record<string, string>): Record<string, string> {
    let result: Record<string, string> = { ...headers };
    if (this.keep.length) {
      const kept = new Set(this.keep.map((name) => name.toLowerCase()));
      const filtered: Record<string, string> = {};
      for (const [name, value] of Object.entries(result)) {
        if (kept.has(name.toLowerCase())) {
          filtered[name] = value;
        }
      }
      result = filtered;
    } else {
      for (const name of this.drop) {
        result = without(result, name.toLowerCase());
      }
    }
    for (const [name, value] of this.add) {
      result = without(result, name.toLowerCase());
      result[name] = value;
    }
    return result;
  }

  get empty(): boolean {
    return !(this.add.length || this.drop.length || this.keep.length);
  }
}

export interface HeaderInfo {
  id: string;
  request: HeaderTransform;
  response: HeaderTransform;
}

/**
 * A reusable `cors` block: the `options` lines answer the preflight, the `headers` lines ride every
 * normal response; every line is an `Access-Control-*: value`.
 */
export interface CorsInfo {
  id: string;
  options: Pair[];
  headers: Pair[];
}

/**
 * The static-content filter: a function that inspects the static requests matching `path` but not
 * `exclusion` (patterns: exact, `prefix*` or `*suffix`).
 */
export interface SimpleHttpFilter {
  pathList: string[];
  exclusionList: string[];
  service: string;
}

/**
 * The `static-content` block: the pages served with no-cache headers instead of the ETag protocol
 * (the entry pages, by default) and the optional request filter.
 */
export interface StaticContentConfig {
  noCachePages: string[];
  filter?: SimpleHttpFilter;
}

export function defaultStaticContent(): StaticContentConfig {
  return { noCachePages: ['/', '/index.html'], filter: undefined };
}

/** A path against exact, `prefix*` and `*suffix` patterns (the engines' rule). */
export function matchedElement(patterns: string[], path: string): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    } else if (pattern.startsWith('*')) {
      if (path.endsWith(pattern.slice(1))) {
        return true;
      }
    } else if (path === pattern) {
      return true;
    }
  }
  return false;
}

function validPatterns(patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (!pattern) {
      return false;
    }
    const stars = pattern.split('*').length - 1;
    if (stars > 1 || (stars === 1 && !(pattern.startsWith('*') || pattern.endsWith('*')))) {
      return false;
    }
  }
  return true;
}

// a URL segment: a case-insensitive literal, a {param} capture, a bare * (any one segment) or a foo*
// prefix; the last two in trailing position let the URL run longer
export type SegmentKind = 'literal' | 'param' | 'any' | 'prefix';
export interface Segment {
  kind: SegmentKind;
  value: string;
}

/** One `rest` entry, parsed. */
export class RouteInfo {
  readonly service: string;
  readonly methods: string[];
  readonly url: string;
  readonly timeoutMs: number;
  readonly cors?: CorsInfo;
  readonly headers?: HeaderInfo;
  readonly authentication?: string;
  readonly tracing: boolean;
  readonly stream: boolean;
  readonly upload: boolean;
  readonly traceIdHeader?: string;
  readonly correlationIdHeader?: string;
  readonly traceparentHeader?: string;
  readonly segments: Segment[];

  constructor(fields: {
    service: string; methods: string[]; url: string; timeoutMs?: number; cors?: CorsInfo; headers?: HeaderInfo;
    authentication?: string; tracing?: boolean; stream?: boolean; upload?: boolean; traceIdHeader?: string;
    correlationIdHeader?: string; traceparentHeader?: string;
  }) {
    this.service = fields.service;
    this.methods = fields.methods;
    this.url = fields.url;
    this.timeoutMs = fields.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cors = fields.cors;
    this.headers = fields.headers;
    this.authentication = fields.authentication;
    this.tracing = fields.tracing ?? false;
    this.stream = fields.stream ?? false;
    this.upload = fields.upload ?? false;
    this.traceIdHeader = fields.traceIdHeader;
    this.correlationIdHeader = fields.correlationIdHeader;
    this.traceparentHeader = fields.traceparentHeader;
    this.segments = segmentsOf(fields.url);
  }

  get timeoutSeconds(): number {
    return Math.max(1, Math.floor(this.timeoutMs / 1000));
  }

  isOpenEnded(): boolean {
    const last = this.segments.at(-1);
    return last !== undefined && (last.kind === 'any' || last.kind === 'prefix');
  }

  get literalCount(): number {
    return this.segments.filter((segment) => segment.kind === 'literal').length;
  }

  /**
   * The `{param}` values when the segments match this entry (literals and prefixes
   * case-insensitively; a trailing wildcard needs at least one remaining segment), else undefined.
   */
  matchPath(requestSegments: string[]): Record<string, string> | undefined {
    if (this.isOpenEnded()) {
      if (this.segments.length > requestSegments.length) {
        return undefined;
      }
    } else if (this.segments.length !== requestSegments.length) {
      return undefined;
    }
    const params: Record<string, string> = {};
    for (const [index, { kind, value }] of this.segments.entries()) {
      const actual = requestSegments[index];
      if (kind === 'literal') {
        if (actual.toLowerCase() !== value) {
          return undefined;
        }
      } else if (kind === 'prefix') {
        if (!actual.toLowerCase().startsWith(value)) {
          return undefined;
        }
      } else if (kind === 'param') {
        params[value] = actual;
      }
    }
    return params;
  }
}

export interface AssignedRoute {
  info: RouteInfo;
  pathParams: Record<string, string>;
}

function segmentsOf(url: string): Segment[] {
  const segments: Segment[] = [];
  for (const part of url.split('/').filter((p) => p.length > 0)) {
    if (part.startsWith('{') && part.endsWith('}') && part.length > 2) {
      segments.push({ kind: 'param', value: part.slice(1, -1) });
    } else if (part === '*') {
      segments.push({ kind: 'any', value: '' });
    } else if (part.endsWith('*')) {
      segments.push({ kind: 'prefix', value: part.slice(0, -1).toLowerCase() });
    } else {
      segments.push({ kind: 'literal', value: part.toLowerCase() });
    }
  }
  return segments;
}

/**
 * A possibly dotted key: the direct key first, then the nested maps a YAML author may have written
 * (`trace: {id: {header: ...}}`) - the engines' ConfigReader rule.
 */
function lookup(entry: Mapping, key: string): unknown {
  if (key in entry) {
    return entry[key];
  }
  let current: unknown = entry;
  for (const part of key.split('.')) {
    if (!isMapping(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

/** Python's str.partition on the first separator: [before, found, after]. */
function partition(line: string, separator: string): [string, boolean, string] {
  const at = line.indexOf(separator);
  return at === -1 ? [line, false, ''] : [line.slice(0, at), true, line.slice(at + separator.length)];
}

function parseHeaderLines(lines: unknown, corsId: string, kind: string): Pair[] {
  const out: Pair[] = [];
  if (!Array.isArray(lines)) {
    return out;
  }
  for (const line of lines) {
    if (typeof line !== 'string') {
      continue;
    }
    const [rawName, found, value] = partition(line, ':');
    if (!found) {
      throw new AppException(400, `cors '${corsId}' ${kind} line '${line}' is not 'name: value'`);
    }
    const name = rawName.trim();
    if (!name.toLowerCase().startsWith('access-control-')) {
      throw new AppException(400, `cors '${corsId}' ${kind} line '${name}' must be an Access-Control-* header`);
    }
    out.push([name, value.trim()]);
  }
  return out;
}

function parseCorsBlocks(section: unknown): Map<string, CorsInfo> {
  const blocks = new Map<string, CorsInfo>();
  if (!Array.isArray(section)) {
    return blocks;
  }
  for (const entry of section) {
    if (!isMapping(entry)) {
      continue;
    }
    const corsId = text(entry.id);
    if (corsId === undefined) {
      throw new AppException(400, "cors block missing 'id'");
    }
    blocks.set(corsId, {
      id: corsId,
      options: parseHeaderLines(entry.options, corsId, 'options'),
      headers: parseHeaderLines(entry.headers, corsId, 'headers')
    });
  }
  return blocks;
}

function parseTransform(section: unknown): HeaderTransform {
  const transform = new HeaderTransform();
  if (!isMapping(section)) {
    return transform;
  }
  const add = section.add;
  if (Array.isArray(add)) {
    for (const line of add) {
      if (typeof line === 'string' && line.includes(':')) {
        const [name, , value] = partition(line, ':');
        transform.add.push([name.trim(), value.trim()]);
      }
    }
  }
  for (const [key, target] of [['drop', transform.drop], ['keep', transform.keep]] as const) {
    const names = section[key];
    if (Array.isArray(names)) {
      target.push(...names.filter((name): name is string => typeof name === 'string'));
    }
  }
  return transform;
}

function parseHeaderBlocks(section: unknown): Map<string, HeaderInfo> {
  const blocks = new Map<string, HeaderInfo>();
  if (!Array.isArray(section)) {
    return blocks;
  }
  for (const entry of section) {
    if (!isMapping(entry)) {
      continue;
    }
    const headerId = text(entry.id);
    if (headerId === undefined) {
      throw new AppException(400, "headers block missing 'id'");
    }
    blocks.set(headerId, {
      id: headerId, request: parseTransform(entry.request), response: parseTransform(entry.response)
    });
  }
  return blocks;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function parseStaticContent(data: Mapping): StaticContentConfig {
  const result = defaultStaticContent();
  const section = data['static-content'];
  if (!isMapping(section)) {
    return result;
  }
  if ('no-cache-pages' in section) {
    const listed = strings(section['no-cache-pages']);
    if (!listed.length || !validPatterns(listed)) {
      throw new AppException(400, 'static-content.no-cache-pages has invalid syntax');
    }
    result.noCachePages = listed;
  }
  if ('filter' in section) {
    const filterSection = section.filter;
    const paths = isMapping(filterSection) ? filterSection.path : undefined;
    if (!Array.isArray(paths)) {
      throw new AppException(400, 'static-content.filter.path must be a list');
    }
    const pathList = strings(paths);
    const service = isMapping(filterSection) ? text(filterSection.service) : undefined;
    if (service === undefined) {
      throw new AppException(400, 'static-content.filter.service is required');
    }
    const exclusionList = isMapping(filterSection) ? strings(filterSection.exclusion) : [];
    if (!pathList.length || !validPatterns(pathList) || !validPatterns(exclusionList)) {
      throw new AppException(400, 'static-content.filter path/exclusion has invalid syntax');
    }
    result.filter = { pathList, exclusionList, service };
  }
  return result;
}

function parseRoute(index: number, entry: Mapping, corsBlocks: Map<string, CorsInfo>,
                    headerBlocks: Map<string, HeaderInfo>): RouteInfo {
  const serviceValue = lookup(entry, 'service');
  if (Array.isArray(serviceValue)) {
    throw new AppException(400,
      `rest[${index}] service must be a single route - the A/B dual service is not available in a language pack`);
  }
  const service = text(serviceValue);
  if (service === undefined) {
    throw new AppException(400, `rest[${index}] missing 'service'`);
  }
  const lowered = service.toLowerCase();
  if (lowered.startsWith('http://') || lowered.startsWith('https://')) {
    throw new AppException(400, `rest[${index}] HTTP relay is not available in a language pack (service '${service}')`);
  }
  const flow = text(lookup(entry, 'flow'));
  if (flow !== undefined || lowered === FLOW_ADAPTER) {
    const binding = flow !== undefined ? `flow '${flow}'` : `service '${service}'`;
    throw new AppException(400,
      `rest[${index}] flow binding is not available in a language pack - flows run in the engines (${binding})`);
  }
  const url = text(lookup(entry, 'url'));
  if (url === undefined) {
    throw new AppException(400, `rest[${index}] missing 'url'`);
  }
  const rawMethods = lookup(entry, 'methods');
  if (!Array.isArray(rawMethods)) {
    throw new AppException(400, `rest[${index}] missing 'methods' list`);
  }
  const methods: string[] = [];
  for (const raw of rawMethods) {
    const method = text(raw);
    if (method === undefined) {
      throw new AppException(400, `rest[${index}] method must be text`);
    }
    const upper = method.toUpperCase();
    if (!(ALLOWED_METHODS as readonly string[]).includes(upper)) {
      const allowed = ALLOWED_METHODS.map((m) => `"${m}"`).join(', ');
      throw new AppException(400, `rest[${index}] invalid method '${upper}' (allowed: [${allowed}])`);
    }
    methods.push(upper);
  }
  let cors: CorsInfo | undefined;
  const corsId = text(lookup(entry, 'cors'));
  if (corsId !== undefined) {
    cors = corsBlocks.get(corsId);
    if (cors === undefined) {
      throw new AppException(400, `rest[${index}] unknown cors id '${corsId}'`);
    }
  }
  let headers: HeaderInfo | undefined;
  const headersId = text(lookup(entry, 'headers'));
  if (headersId !== undefined) {
    headers = headerBlocks.get(headersId);
    if (headers === undefined) {
      throw new AppException(400, `rest[${index}] unknown headers id '${headersId}'`);
    }
  }
  return new RouteInfo({
    service, methods, url,
    timeoutMs: parseTimeout(lookup(entry, 'timeout')),
    cors, headers,
    authentication: text(lookup(entry, 'authentication')),
    tracing: lookup(entry, 'tracing') === true,
    stream: lookup(entry, 'stream') === true,
    upload: lookup(entry, 'upload') === true,
    traceIdHeader: text(lookup(entry, 'trace.id.header')),
    correlationIdHeader: text(lookup(entry, 'correlation.id.header')),
    traceparentHeader: text(lookup(entry, 'traceparent.header'))
  });
}

/**
 * Every string of a loaded YAML document through the configuration's `${ENV:default}` substitution
 * (the engines resolve `${api.origin:*}` in a cors line the same way).
 */
export function substituteValues(data: unknown, resolve: (value: string) => unknown): unknown {
  if (typeof data === 'string') {
    const resolved = resolve(data);
    if (resolved === undefined || resolved === null) {
      return data;
    }
    return typeof resolved === 'string' ? resolved : asText(resolved);
  }
  if (Array.isArray(data)) {
    return data.map((item) => substituteValues(item, resolve));
  }
  if (isMapping(data)) {
    const out: Mapping = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = substituteValues(value, resolve);
    }
    return out;
  }
  return data;
}

/** A YAML text as the Python pack's `yaml.safe_load` reads it: an empty document is null. */
export function parseYaml(yamlText: string): unknown {
  // YAML 1.1 (yes/no/on/off are booleans, as PyYAML reads them) with duplicate keys tolerated, the
  // last winning - so an engine's rest.yaml reads here as it reads in the Python pack
  return YAML.parse(yamlText, { version: '1.1', uniqueKeys: false });
}

const pathSegments = (path: string): string[] => path.split('/').filter((s) => s.length > 0);

/** The parsed routing table (the engines' `RoutingEntry`). */
export class RoutingTable {
  constructor(public routes: RouteInfo[] = [],
              public staticContent: StaticContentConfig = defaultStaticContent()) {}

  /**
   * Load and validate a `rest.yaml` document (a parsed YAML mapping). An invalid entry fails the
   * load with the engines' message - a misconfigured endpoint is a startup error.
   */
  static load(data: unknown): RoutingTable {
    if (!isMapping(data)) {
      throw new AppException(400, 'rest.yaml text must be a YAML mapping');
    }
    const corsBlocks = parseCorsBlocks(data.cors);
    const headerBlocks = parseHeaderBlocks(data.headers);
    const entries = data.rest;
    if (!Array.isArray(entries)) {
      throw new AppException(400, "rest.yaml has no 'rest' section");
    }
    const routes: RouteInfo[] = [];
    for (const [index, entry] of entries.entries()) {
      if (!isMapping(entry)) {
        throw new AppException(400, `rest[${index}] is not a map`);
      }
      routes.push(parseRoute(index, entry, corsBlocks, headerBlocks));
    }
    return new RoutingTable(routes, parseStaticContent(data));
  }

  static fromYamlText(yamlText: string): RoutingTable {
    return RoutingTable.load(parseYaml(yamlText));
  }

  hasUrl(url: string): boolean {
    const lowered = url.toLowerCase();
    return this.routes.some((route) => route.url.toLowerCase() === lowered);
  }

  addRoute(route: RouteInfo): void {
    this.routes.push(route);
  }

  /** The engines' default endpoints, added when the file does not claim their URLs. */
  mergeDefaults(): void {
    for (const route of RoutingTable.fromYamlText(DEFAULT_REST_YAML).routes) {
      if (!this.hasUrl(route.url)) {
        this.addRoute(route);
      }
    }
  }

  /**
   * Drop every entry whose service is not registered, the engines' load-time rule (`Skip [GET]
   * /api/x - Service x not available`): an entry whose function was left out must not become a live
   * URL. Returns the skipped `["[methods]", url, service]` for the log.
   */
  retainAvailable(isRegistered: (service: string) => boolean): Array<[string, string, string]> {
    const skipped: Array<[string, string, string]> = [];
    const kept: RouteInfo[] = [];
    for (const route of this.routes) {
      if (isRegistered(route.service)) {
        kept.push(route);
      } else {
        skipped.push([`[${route.methods.join(', ')}]`, route.url, route.service]);
      }
    }
    this.routes = kept;
    return skipped;
  }

  /**
   * The entry a request matches: every segment must match; a non-wildcard entry beats a wildcard
   * one, then more literal segments win. `OPTIONS` matches any entry (the CORS preflight is
   * auto-added per the grammar).
   */
  find(method: string, path: string): AssignedRoute | undefined {
    const segments = pathSegments(path);
    let best: { literals: number; wildcard: boolean; assigned: AssignedRoute } | undefined;
    for (const info of this.routes) {
      if (method !== 'OPTIONS' && !info.methods.includes(method)) {
        continue;
      }
      const params = info.matchPath(segments);
      if (params === undefined) {
        continue;
      }
      const literals = info.literalCount;
      const wildcard = info.isOpenEnded();
      if (best === undefined || (!wildcard && best.wildcard) ||
          (wildcard === best.wildcard && literals > best.literals)) {
        best = { literals, wildcard, assigned: { info, pathParams: params } };
      }
    }
    return best?.assigned;
  }

  /** True when the path matches some entry regardless of method - a known path under a wrong method is 405, never 404. */
  pathMatchesAnyMethod(path: string): boolean {
    const segments = pathSegments(path);
    return this.routes.some((info) => info.matchPath(segments) !== undefined);
  }
}

// ---- the pure rules of the edge ----

const HEX = /^[0-9A-Fa-f]{2}$/;

/**
 * Percent-decoding with `+` as a space, for path and query values - Python's `unquote_plus`: a `%`
 * not followed by two hex digits stays literal, an invalid UTF-8 sequence becomes U+FFFD.
 */
export function urlDecode(value: string): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '%' && HEX.test(value.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (char === '+') {
      bytes.push(0x20);
    } else {
      bytes.push(...encoder.encode(char));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

export type QueryValues = Record<string, string | string[]>;

/** Query parameters: one occurrence is a string, a repeated key becomes a list (the engines keep every value). */
export function parseQuery(queryText: string): QueryValues {
  const query: QueryValues = {};
  for (const pair of queryText.split('&').filter((p) => p.length > 0)) {
    const [rawName, , rawValue] = partition(pair, '=');
    const name = urlDecode(rawName);
    const value = urlDecode(rawValue);
    const existing = query[name];
    if (existing === undefined) {
      query[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[name] = [existing, value];
    }
  }
  return query;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const item of header.split(';')) {
    const [name, found, value] = partition(item, '=');
    if (found) {
      cookies[name.trim()] = value.trim();
    }
  }
  return cookies;
}

/** The content type without a `;charset=...` suffix; the value matched case-sensitively. */
export function baseContentType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) {
    return undefined;
  }
  return partition(contentType, ';')[0].trim();
}

/**
 * The request body by its declared content type: `value` (a map, a list, text or null), `form`
 * (fields that become query parameters) or `bytes`.
 */
export interface ParsedBody {
  kind: 'value' | 'form' | 'bytes' | 'upload';
  value: unknown;
}

/**
 * The engines' content-type dispatch: `application/json` - an empty body is `{}`, a body in matching
 * brackets is parsed and a parse failure falls back to the raw text, anything else stays text, and
 * there is no JSON sniffing under any other type; `application/xml`, `text/html` and `text/plain` -
 * text; `application/x-www-form-urlencoded` - form fields; anything else or no content type - raw
 * bytes, an empty payload null.
 */
export function parseBody(contentType: string | undefined, data: Buffer): ParsedBody {
  const ct = baseContentType(contentType) || '?';
  if (ct.startsWith('application/json')) {
    const body = data.toString('utf-8');
    const trimmed = body.trim();
    if (!trimmed) {
      return { kind: 'value', value: {} };
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return { kind: 'value', value: JSON.parse(body) };
      } catch {
        return { kind: 'value', value: body };
      }
    }
    return { kind: 'value', value: body };
  }
  if (ct === 'application/x-www-form-urlencoded') {
    const fields: Record<string, string> = {};
    for (const pair of data.toString('utf-8').split('&').filter((p) => p.length > 0)) {
      const [name, , value] = partition(pair, '=');
      fields[urlDecode(name)] = urlDecode(value);
    }
    return { kind: 'form', value: fields };
  }
  if (ct.startsWith('application/xml') || ct.startsWith('text/html') || ct.startsWith('text/plain')) {
    return { kind: 'value', value: data.toString('utf-8') };
  }
  if (!data.length) {
    return { kind: 'value', value: null };
  }
  return { kind: 'bytes', value: Buffer.from(data) };
}

/**
 * The response content type when the function set none: `text/html` for a browser,
 * `application/json` for json, `*\/*` and xml (the port's XML deferral), no `Accept` means no
 * content-type header at all, anything else `text/plain`.
 */
export function acceptFallbackType(accept: string | undefined): string | undefined {
  if (accept === undefined) {
    return undefined;
  }
  if (accept.includes('text/html')) {
    return 'text/html';
  }
  if (accept.includes('application/json') || accept.includes('*/*') || accept.includes('application/xml')) {
    return 'application/json';
  }
  return 'text/plain';
}

/** The content type of a streamed response when the head sets none. */
export function negotiateStreamType(accept: string | undefined): string {
  if (accept === undefined) {
    return 'application/json';
  }
  if (accept.includes('*/*') || accept.includes('application/json')) {
    return 'application/json';
  }
  if (accept.includes('text/event-stream')) {
    return 'text/event-stream';
  }
  if (accept.includes('text/html')) {
    return 'text/html';
  }
  if (accept.includes('application/xml')) {
    return 'application/xml';
  }
  return 'text/plain';
}

/** Map entries whose value is null are omitted (the engines' serializer default). */
export function stripNulls(value: unknown): unknown {
  if (isMapping(value)) {
    const out: Mapping = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== null && item !== undefined) {
        out[key] = stripNulls(item);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNulls(item));
  }
  return value;
}

/** A map or list body as the engines render it: pretty-printed, two spaces, Unicode kept. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(stripNulls(value), null, 2);
}

export function compactJson(value: unknown): string {
  return JSON.stringify(stripNulls(value));
}

/**
 * A segment body as line-oriented text: text as is, bytes as UTF-8, a structure as compact JSON
 * (the engines' stream framing is line-oriented).
 */
export function streamText(body: unknown): string {
  if (body === null || body === undefined) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString('utf-8');
  }
  return compactJson(body);
}

/**
 * The response body per the effective content type: text and bytes ride raw regardless of the
 * negotiated type; a map or list renders as pretty JSON, wrapped in the HTML shell when the type is
 * `text/html`.
 */
export function renderPayload(body: unknown, contentType: string | undefined): Buffer {
  if (body === null || body === undefined) {
    return Buffer.alloc(0);
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf-8');
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  const rendered = prettyJson(body);
  if (contentType?.startsWith('text/html') && (isMapping(body) || Array.isArray(body))) {
    return Buffer.from(`${HTML_START}${rendered}${HTML_END}`, 'utf-8');
  }
  return Buffer.from(rendered, 'utf-8');
}

/** The engines' error shape: `{"status": n, "message": "...", "type": "error"}`. */
export function errorBody(status: number, message: string): Record<string, unknown> {
  return { status, message, type: 'error' };
}

export function errorPayload(status: number, message: string): Buffer {
  return Buffer.from(prettyJson(errorBody(status, message)), 'utf-8');
}

/** A reply envelope mapped to HTTP: the status, the header lines in order (`set-cookie` may repeat) and the body bytes. */
export interface MappedResponse {
  status: number;
  headers: Pair[];
  body: Buffer;
}

/**
 * The engines' mapping of a function's reply to the HTTP response. A failure - an error status
 * with a text body and no headers of its own, the shape of a thrown `AppException` - renders as the
 * standard error body unless the text already looks like JSON or XML. The reserved `my_*` metadata
 * and the streaming handles never reach the wire; a function-set `content-type` wins over the
 * `Accept` negotiation (not for HEAD); `set-cookie` values separated by `|` become one header each;
 * the entry's response transform filters the headers (content type and cookies bypass it); the
 * correlation id is echoed under its header name unless the function set one; the CORS headers come
 * last; a HEAD response carries no body.
 */
export function mapResponse(args: {
  status: number; replyHeaders: Record<string, string>; body: unknown; accept: string | undefined;
  isHead: boolean; transform: HeaderTransform | undefined; cors: CorsInfo | undefined; cid: string; cidHeader: string;
}): MappedResponse {
  const { status, replyHeaders, accept, isHead, transform, cors, cid, cidHeader } = args;
  let body = args.body;
  let standardError = false;
  if (status >= 400 && typeof body === 'string' && !Object.keys(replyHeaders).length) {
    const message = body.trim();
    if (!(message.startsWith('{') || message.startsWith('[') || message.startsWith('<'))) {
      body = errorBody(status, message);
      standardError = true;
    }
  }
  let contentType: string | undefined;
  const cookies: string[] = [];
  let headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(replyHeaders)) {
    const key = name.toLowerCase();
    if (key.startsWith(PROTECTED_PREFIX)) {
      continue;
    }
    if (key === 'x-stream-id' && value.startsWith('stream.') && value.includes('.in')) {
      continue;
    }
    if (key === 'x-ttl') {
      continue;
    }
    if (key === 'content-type') {
      if (!isHead) {
        contentType = value.toLowerCase();
      }
    } else if (key === 'set-cookie') {
      cookies.push(...value.split('|').map((c) => c.trim()));
    } else {
      headers[key] = value;
    }
  }
  if (contentType === undefined && !isHead) {
    contentType = acceptFallbackType(accept);
  }
  if (standardError && contentType === undefined && !isHead) {
    contentType = 'application/json';
  }
  const payload = isHead ? Buffer.alloc(0) : renderPayload(body, contentType);
  if (transform !== undefined) {
    headers = transform.apply(headers);
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === cidHeader)) {
    headers[cidHeader] = cid;
  }
  if (contentType !== undefined) {
    headers['content-type'] = contentType;
  }
  if (cors !== undefined) {
    for (const [name, value] of cors.headers) {
      headers[name.toLowerCase()] = value;
    }
  }
  const lines: Pair[] = Object.entries(headers);
  for (const cookie of cookies) {
    if (cookie) {
      lines.push(['set-cookie', cookie]);
    }
  }
  return { status, headers: lines, body: payload };
}

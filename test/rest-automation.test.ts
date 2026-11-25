/**
 * REST automation pins: the shared vector file over the pure half, and the edge over real HTTP - the
 * engines' behaviour, the Rust port's test list as the checklist (RFC-0018). The vector file is the
 * Python pack's, byte for byte; the HTTP checklist mirrors tests/test_rest_automation.py there.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AsyncHttpRequest } from '../src/async-http-request.js';
import { appConfig, loadConfig } from '../src/config.js';
import { EventEnvelope } from '../src/envelope.js';
import { EventStreamWriter } from '../src/event-stream.js';
import { AppException } from '../src/exceptions.js';
import { FunctionRegistry } from '../src/registry.js';
import {
  acceptFallbackType,
  CorsInfo,
  errorBody,
  HeaderTransform,
  mapResponse,
  negotiateStreamType,
  parseBody,
  parseCookies,
  parseQuery,
  parseTimeout,
  renderPayload,
  RouteInfo,
  RoutingTable,
  streamText
} from '../src/rest-routing.js';
import { EventApiServer, RouteMounter } from '../src/server.js';
import { getTrace } from '../src/trace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_FILE = path.resolve(here, '../../test/vectors/rest-automation-vectors.json');
// the Python twin pins the same digest: change the file in both packs or in neither
const VECTORS_SHA256 = 'a9b7ef8b1b065dc3b9a0b3cd92e0d518ac1027406624445fa82c4d965f39082e';
const MY_CID = 'my_correlation_id';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const vectors: Json = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf-8'));
const orNull = (value: unknown): unknown => value ?? null;
const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

// ---- the shared vectors over the pure half ----

function routeView(route: RouteInfo): Json {
  return {
    service: route.service, methods: route.methods, url: route.url, timeout_ms: route.timeoutMs,
    cors: orNull(route.cors?.id), headers: orNull(route.headers?.id), authentication: orNull(route.authentication),
    tracing: route.tracing, stream: route.stream, upload: route.upload, trace_id_header: orNull(route.traceIdHeader),
    correlation_id_header: orNull(route.correlationIdHeader), traceparent_header: orNull(route.traceparentHeader)
  };
}

test('the vector file is the one the python twin runs', () => {
  const digest = createHash('sha256').update(fs.readFileSync(VECTORS_FILE)).digest('hex');
  assert.equal(digest, VECTORS_SHA256, "update both packs' pins when the shared file changes");
  assert.equal(vectors.version, 2);
});

test('vectors: load cases', () => {
  for (const c of vectors.load_cases) {
    if ('error' in c) {
      assert.throws(() => RoutingTable.fromYamlText(c.yaml), (e: unknown) => {
        assert.ok(e instanceof AppException, c.name);
        assert.equal(e.status, 400, c.name);
        assert.equal(e.message, c.error, c.name);
        return true;
      });
      continue;
    }
    const table = RoutingTable.fromYamlText(c.yaml);
    assert.deepEqual(table.routes.map(routeView), c.routes, c.name);
    const content = table.staticContent;
    assert.deepEqual(content.noCachePages, c.static.no_cache_pages, c.name);
    if (c.static.filter === null) {
      assert.equal(content.filter, undefined, c.name);
    } else {
      assert.ok(content.filter, c.name);
      assert.deepEqual({ path: content.filter.pathList, exclusion: content.filter.exclusionList, service: content.filter.service },
        c.static.filter, c.name);
    }
  }
});

test('vectors: timeout cases', () => {
  for (const c of vectors.timeout_cases) {
    assert.equal(parseTimeout(c.value), c.ms, JSON.stringify(c));
  }
});

test('vectors: match cases', () => {
  const tables = new Map<string, RoutingTable>();
  for (const [name, yamlText] of Object.entries(vectors.tables as Record<string, string>)) {
    tables.set(name, RoutingTable.fromYamlText(yamlText));
  }
  for (const c of vectors.match_cases) {
    const table = tables.get(c.table)!;
    const found = table.find(c.method, c.path);
    if ('status' in c) {
      assert.equal(found, undefined, c.name);
      const expected = c.status === 405 ? 405 : 404;
      assert.equal(table.pathMatchesAnyMethod(c.path) ? 405 : 404, expected, c.name);
    } else {
      assert.ok(found, c.name);
      assert.equal(found.info.service, c.service, c.name);
      assert.deepEqual(found.pathParams, c.params, c.name);
    }
  }
});

const lowered = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

function transformOf(spec: Json | null): HeaderTransform | undefined {
  if (spec === null) {
    return undefined;
  }
  return new HeaderTransform((spec.add ?? []).map((pair: [string, string]) => [...pair] as [string, string]),
    [...(spec.drop ?? [])], [...(spec.keep ?? [])]);
}

test('vectors: header transform cases', () => {
  for (const c of vectors.header_transform_cases) {
    assert.deepEqual(lowered(transformOf(c.transform)!.apply(c.headers)), lowered(c.expect), c.name);
  }
});

test('vectors: body cases', () => {
  for (const c of vectors.body_cases) {
    const parsed = parseBody(orUndefined(c.content_type), Buffer.from(c.body, 'utf-8'));
    assert.equal(parsed.kind, c.kind, c.name);
    const value = parsed.kind === 'bytes' ? (parsed.value as Buffer).toString('utf-8') : parsed.value;
    assert.deepEqual(value, c.value, c.name);
  }
});

test('vectors: query and cookie cases', () => {
  for (const c of vectors.query_cases) {
    assert.deepEqual(parseQuery(c.query), c.expect, JSON.stringify(c));
  }
  for (const c of vectors.cookie_cases) {
    assert.deepEqual(parseCookies(orUndefined(c.header)), c.expect, JSON.stringify(c));
  }
});

test('vectors: negotiation cases', () => {
  for (const c of vectors.negotiation_cases) {
    assert.equal(orNull(acceptFallbackType(orUndefined(c.accept))), c.type, JSON.stringify(c));
  }
  for (const c of vectors.stream_negotiation_cases) {
    assert.equal(negotiateStreamType(orUndefined(c.accept)), c.type, JSON.stringify(c));
  }
});

function build(spec: Json): AsyncHttpRequest {
  const request = new AsyncHttpRequest();
  if ('method' in spec) request.setMethod(spec.method);
  if ('url' in spec) request.setUrl(spec.url);
  if ('host' in spec) request.setTargetHost(spec.host);
  if ('ip' in spec) request.setRemoteIp(spec.ip);
  if ('https' in spec) request.setSecure(spec.https);
  if ('timeout' in spec) request.setTimeoutSeconds(spec.timeout);
  for (const [name, value] of Object.entries(spec.headers ?? {})) request.setHeader(name, value as string);
  for (const [name, value] of Object.entries(spec.path ?? {})) request.setPathParameter(name, value as string);
  for (const [name, value] of Object.entries(spec.query ?? {})) request.setQueryParameter(name, value as string | string[]);
  if ('body' in spec) request.setBody(spec.body);
  if ('query_string' in spec) request.setQueryString(spec.query_string);
  for (const [name, value] of Object.entries(spec.cookies ?? {})) request.setCookie(name, value as string);
  for (const [name, value] of Object.entries(spec.session ?? {})) request.setSessionInfo(name, value as string);
  for (const uploaded of spec.files ?? []) {
    request.addFile(uploaded.name, uploaded.content_type, Buffer.from(uploaded.content_base64, 'base64'), uploaded.tag);
  }
  return request;
}

/** A map's file bytes as the vector file carries them (JSON holds no bytes). */
function withBase64(data: Json): Json {
  if ('contents' in data) {
    const { contents, ...rest } = data;
    return { ...rest, contents_base64: (contents as Uint8Array[]).map((c) => Buffer.from(c).toString('base64')) };
  }
  return data;
}

function fromBase64(data: Json): Json {
  if ('contents_base64' in data) {
    const { contents_base64, ...rest } = data;
    return { ...rest, contents: (contents_base64 as string[]).map((c) => Buffer.from(c, 'base64')) };
  }
  return data;
}

/** The Python accessor a vector names (`path_parameter.user`) read through its camel-cased twin here. */
function read(request: AsyncHttpRequest, key: string): unknown {
  const [name, argument] = key.split('.', 2) as [string, string | undefined];
  const camel = name.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase());
  const attribute = (request as unknown as Record<string, unknown>)[camel];
  if (typeof attribute === 'function') {
    return (attribute as (arg: string) => unknown).call(request, argument ?? '');
  }
  assert.equal(argument, undefined, `${key} names an argument for a property`);
  return attribute;
}

test('vectors: request model cases', () => {
  for (const c of vectors.request_model_cases) {
    assert.deepEqual(withBase64(build(c.build).toMap()), c.map, c.name);
  }
  for (const c of vectors.request_read_cases) {
    const request = new AsyncHttpRequest(c.map);
    for (const [key, expected] of Object.entries(c.expect)) {
      assert.deepEqual(orNull(read(request, key)), expected, `${c.name}: ${key}`);
    }
  }
});

test('vectors: upload read cases', () => {
  for (const c of vectors.upload_read_cases) {
    const request = new AsyncHttpRequest(fromBase64(c.map));
    assert.equal(request.isFile, c.expect.is_file, c.name);
    assert.equal(orNull(request.contentLength), c.expect.content_length, c.name);
    assert.deepEqual(request.uploadTags, c.expect.upload_tags, c.name);
    const files = request.files().map((f) => ({
      name: f.name, content_type: f.contentType, size: f.size, tag: f.tag, content_base64: f.content.toString('base64')
    }));
    assert.deepEqual(files, c.expect.files, c.name);
  }
});

const sortedLines = (lines: Array<[string, string]>): Array<[string, string]> =>
  lines.map(([n, v]) => [n.toLowerCase(), v] as [string, string]).sort((a, b) => `${a[0]}=${a[1]}`.localeCompare(`${b[0]}=${b[1]}`));

test('vectors: response cases', () => {
  for (const c of vectors.response_cases) {
    const cors: CorsInfo | undefined = c.cors === null ? undefined
      : { id: 'c', options: [], headers: (c.cors.headers ?? []).map((pair: [string, string]) => [...pair] as [string, string]) };
    const mapped = mapResponse({
      status: c.status, replyHeaders: c.reply_headers, body: c.body, accept: orUndefined(c.accept), isHead: c.head,
      transform: transformOf(c.transform), cors, cid: c.cid, cidHeader: c.cid_header
    });
    assert.equal(mapped.status, c.expect.status, c.name);
    assert.deepEqual(sortedLines(mapped.headers), sortedLines(c.expect.headers), c.name);
    assert.equal(mapped.body.toString('utf-8'), c.expect.body, c.name);
  }
});

test('vectors: render cases', () => {
  for (const c of vectors.render_cases) {
    assert.equal(renderPayload(c.body, orUndefined(c.type)).toString('utf-8'), c.text, JSON.stringify(c));
  }
  for (const c of vectors.stream_text_cases) {
    assert.equal(streamText(c.body), c.text, JSON.stringify(c));
  }
  for (const c of vectors.error_body_cases) {
    assert.deepEqual(errorBody(c.status, c.message), c.expect);
  }
});

test('a bytes body rides raw', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const mapped = mapResponse({
    status: 200, replyHeaders: { 'content-type': 'image/png' }, body: png, accept: '*/*', isHead: false,
    transform: undefined, cors: undefined, cid: 'c', cidHeader: 'x-correlation-id'
  });
  assert.ok(mapped.body.equals(png));
  assert.ok(mapped.headers.some(([n, v]) => n === 'content-type' && v === 'image/png'));
});

// ---- the edge over HTTP ----

const REST_YAML = `rest:
  - service: "http.echo"
    methods: ['GET', 'POST']
    url: "/api/echo/{user}"
    timeout: 5s
    cors: cors_1
    headers: header_1
  - service: "ghost.service"
    methods: ['GET']
    url: "/api/ghost"
  - service: "plain.text"
    methods: ['GET']
    url: "/index.html"
  - service: "header.probe"
    methods: ['GET', 'HEAD']
    url: "/api/headers"
    headers: header_1
  - service: "request.view"
    methods: ['GET']
    url: "/api/request/view"
  - service: "plain.text"
    methods: ['GET']
    url: "/api/files/*"
  - service: "plain.text"
    methods: ['GET']
    url: "/api/v*/ping"
  - service: "plain.text"
    methods: ['GET']
    url: "/api/mid/*/end"
  - service: "trace.probe"
    methods: ['GET']
    url: "/api/traced"
    tracing: true
  - service: "trace.probe"
    methods: ['GET']
    url: "/api/renamed/traceparent/probe"
    tracing: true
    traceparent.header: "X-Endpoint-Trace"
  - service: "trace.header.echo"
    methods: ['GET']
    url: "/api/echo/headers"
    timeout: 5s
  - service: "plain.text"
    methods: ['GET']
    url: "/api/text"
  - service: "body.probe"
    methods: ['POST']
    url: "/api/probe"
  - service: "slow.text"
    methods: ['GET']
    url: "/api/slow"
    timeout: 1s
  - service: "http.echo"
    methods: ['GET']
    url: "/api/secure"
    authentication: "api.key.check"
  - service: "failing.service"
    methods: ['GET']
    url: "/api/fail"
  - service: "json.error.service"
    methods: ['GET']
    url: "/api/fail/json"
  - service: "envelope.probe"
    methods: ['GET']
    url: "/api/envelope/{user}"
  - service: "token.stream"
    methods: ['POST']
    url: "/api/stream"
    stream: true
    headers: header_1
  - service: "stream.fail"
    methods: ['POST']
    url: "/api/stream/fail"
    stream: true
  - service: "lines.stream"
    methods: ['POST']
    url: "/api/stream/lines"
    stream: true
  - service: "token.stream"
    methods: ['POST']
    url: "/api/stream/single"
  - service: "info.actuator.service"
    methods: ['GET']
    url: "/ops/info"
    authentication: "api.key.check"
  - service: "upload.probe"
    methods: ['POST']
    url: "/api/upload"
    upload: true
cors:
  - id: cors_1
    options:
      - "Access-Control-Allow-Origin: *"
      - "Access-Control-Allow-Methods: GET, POST, OPTIONS"
    headers:
      - "Access-Control-Allow-Origin: \${api.origin:*}"
headers:
  - id: header_1
    response:
      add: ["x-served-by: mercury"]
`;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-rest-'));
});

after(() => {
  loadConfig(); // a fresh default configuration for the other modules
  fs.rmSync(root, { recursive: true, force: true });
});

let folders = 0;

/**
 * An application folder whose resources hold the rest.yaml (and a web bundle), loaded as the shared
 * configuration with the settings given; the caller restores the default configuration afterwards.
 */
function configured(restYaml: string | undefined, settings: Record<string, unknown> = {},
                    publicFiles: Record<string, string> = {}): string {
  const folder = path.join(root, `app${++folders}`);
  fs.mkdirSync(path.join(folder, 'resources'), { recursive: true });
  if (restYaml !== undefined) {
    write(path.join(folder, 'resources', 'rest.yaml'), restYaml);
  }
  for (const [name, text] of Object.entries(publicFiles)) {
    write(path.join(folder, 'resources', 'public', name), text);
  }
  loadConfig(undefined, folder);
  const config = appConfig();
  config.set('rest.automation', true);
  for (const [key, value] of Object.entries(settings)) {
    config.set(key, value);
  }
  return folder;
}

/** What the probe functions observed. */
class Probe {
  trace: [string | undefined, string | undefined, string | undefined] | undefined;
  datasets: Json[] = [];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildRegistry(probe: Probe): FunctionRegistry {
  const registry = new FunctionRegistry();
  const asMap = (body: unknown): Json | undefined =>
    body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Json : undefined;

  registry.register('http.echo', async (headers, body) => {
    const request = new AsyncHttpRequest(body);
    return {
      user: request.pathParameter('user'), q: request.queryParameter('q'), my_cid: headers[MY_CID],
      echo_body: request.body, method: request.method, session: request.session, headers: request.headers
    };
  });
  registry.register('plain.text', async () => 'plain response');
  registry.register('slow.text', async () => {
    await sleep(2500);
    return 'late';
  });
  registry.register('body.probe', async (_headers, body) => {
    const request = new AsyncHttpRequest(body);
    const value = request.body;
    const map = asMap(body);
    const kind = map === undefined || !('body' in map) ? 'missing'
      : value === null ? 'null'
        : typeof value === 'string' ? 'text'
          : value instanceof Uint8Array ? 'bytes'
            : Array.isArray(value) ? 'list'
              : asMap(value) !== undefined ? 'map' : 'other';
    const content = value instanceof Uint8Array ? Buffer.from(value).toString('utf-8') : value;
    return { kind, content, query: request.queryParametersMap };
  });
  registry.register('request.view', async (_headers, body) => {
    const request = new AsyncHttpRequest(body);
    return {
      q: request.queryParametersMap.q, single: request.queryParameter('single'),
      cookie_first: request.cookie('first'), cookie_second: request.cookie('second'),
      cookie_header: request.header('cookie'), query: request.queryString, https: request.isSecure,
      ip: request.remoteIp, timeout: request.timeoutSeconds
    };
  });
  registry.register('api.key.check', async (_headers, body) => {
    const request = new AsyncHttpRequest(body);
    const allowed = request.header('x-api-key') === 'open-sesame';
    return new EventEnvelope().setHeader('user', 'demo').setBody(allowed);
  });
  registry.register('header.probe', async () => new EventEnvelope().setStatus(302)
    .setHeader('Location', '/somewhere/else').setHeader('Content-Type', 'application/vnd.demo+json')
    .setHeader('Set-Cookie', 'first=1; Path=/|second=2; HttpOnly').setHeader('X-Custom', 'custom-value')
    .setHeader('x-stream-id', 'stream.100.in').setHeader('x-ttl', '10').setBody({ moved: true }));
  registry.register('trace.probe', async (headers) => {
    const info = getTrace();
    probe.trace = [info?.traceId, info?.tracePath, headers[MY_CID]];
    return 'traced';
  });
  registry.register('trace.header.echo', async (_headers, body) => ({ headers: new AsyncHttpRequest(body).headers }));
  registry.register('failing.service', async () => {
    throw new AppException(404, 'nothing here');
  });
  registry.register('json.error.service', async () => new EventEnvelope().setStatus(409).setBody('{"custom":true}'));
  registry.register('envelope.probe', async (_headers, body) => {
    const request = new AsyncHttpRequest(body);
    return new EventEnvelope().setStatus(202).setHeader('x-typed-reply', 'envelope')
      .setBody({ user: request.pathParameter('user'), accepted: true });
  });
  registry.register('token.stream', async (_headers, event) => {
    const out = EventStreamWriter.fromRequest(event as EventEnvelope, registry);
    out.first(200, 'text/event-stream');
    out.write('hello');
    out.writeNamed('tokens', { n: 2 });
    out.close({ usage: 1 });
  }, { interceptor: true });
  registry.register('lines.stream', async (_headers, event) => {
    const out = EventStreamWriter.fromRequest(event as EventEnvelope, registry);
    out.first(200, 'application/json');
    out.write('hello');
    out.write({ n: 2 });
    out.close();
  }, { interceptor: true });
  registry.register('stream.fail', async (_headers, event) => {
    const out = EventStreamWriter.fromRequest(event as EventEnvelope, registry);
    out.first(200, 'text/event-stream');
    out.write('partial');
    out.fail(new AppException(503, 'upstream down'));
  }, { interceptor: true });
  registry.register('upload.probe', async (_headers, body) => {
    const request = new AsyncHttpRequest(body);
    const map = asMap(body);
    return {
      files: request.files().map((f) => ({
        name: f.name, type: f.contentType, size: f.size, tag: f.tag, sha256: createHash('sha256').update(f.content).digest('hex')
      })),
      query: request.queryParametersMap, body_present: map !== undefined && 'body' in map,
      size: request.contentLength, is_file: request.isFile
    };
  });
  registry.register('distributed.trace.forwarder', async (_headers, body) => {
    const map = asMap(body);
    if (map !== undefined) {
      probe.datasets.push(map);
    }
  }, { isPrivate: true });
  return registry;
}

interface Served { base: string; api: EventApiServer; stop: () => Promise<void> }

async function start(registry: FunctionRegistry, routes: RouteMounter[] = []): Promise<Served> {
  const api = new EventApiServer(registry);
  const server = api.createServer(routes);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    api,
    stop: () => new Promise<void>((resolve) => {
      registry.bus.close();
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

interface Exchange { status: number; lines: Array<[string, string]>; body: Buffer }

/** One exchange with only the headers given - no Accept unless sent; the headers as lowercased lines so repeats stay visible. */
function exchange(url: string, method = 'GET', headers: Record<string, string> = {},
                  data?: Buffer | string): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = data === undefined ? undefined : typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const sent: Record<string, string> = { ...headers };
    if (payload !== undefined) {
      sent['content-length'] = String(payload.length);
    }
    const request = http.request({
      host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers: sent
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const lines: Array<[string, string]> = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          lines.push([response.rawHeaders[i].toLowerCase(), response.rawHeaders[i + 1]]);
        }
        resolve({ status: response.statusCode ?? 0, lines, body: Buffer.concat(chunks) });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const header = (lines: Array<[string, string]>, name: string): string | undefined =>
  lines.find(([k]) => k === name)?.[1];
const headersNamed = (lines: Array<[string, string]>, name: string): string[] =>
  lines.filter(([k]) => k === name).map(([, v]) => v);
const json = (body: Buffer): Json => JSON.parse(body.toString('utf-8'));

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) {
      return;
    }
    await sleep(20);
  }
  throw new assert.AssertionError({ message: 'telemetry not seen' });
}

describe('the edge over HTTP', () => {
  const probe = new Probe();
  let served: Served;
  let base: string;

  before(async () => {
    configured(REST_YAML, { 'http.traceparent.header': 'X-Trace-Context' });
    served = await start(buildRegistry(probe));
    base = served.base;
  });

  after(async () => {
    await served.stop();
    loadConfig();
  });

  test('function response headers survive the REST boundary', async () => {
    const { status, lines, body } = await exchange(`${base}/api/headers`);
    assert.equal(status, 302);
    assert.equal(header(lines, 'location'), '/somewhere/else');
    assert.equal(header(lines, 'content-type'), 'application/vnd.demo+json');
    assert.equal(header(lines, 'x-custom'), 'custom-value');
    assert.deepEqual(headersNamed(lines, 'set-cookie'), ['first=1; Path=/', 'second=2; HttpOnly']);
    assert.equal(header(lines, 'x-served-by'), 'mercury');
    assert.equal(header(lines, 'x-stream-id'), undefined);
    assert.equal(header(lines, 'x-ttl'), undefined);
    assert.deepEqual(json(body), { moved: true });
  });

  test('a HEAD response carries the headers but no body', async () => {
    const { status, lines, body } = await exchange(`${base}/api/headers`, 'HEAD');
    assert.equal(status, 302);
    assert.equal(header(lines, 'location'), '/somewhere/else');
    assert.notEqual(header(lines, 'content-type'), 'application/vnd.demo+json');
    assert.equal(body.length, 0);
  });

  test('GET with a path parameter, a query and a generated correlation id', async () => {
    const { status, lines, body } = await exchange(`${base}/api/echo/eric?q=hello%20world`, 'GET', { Accept: 'application/json' });
    assert.equal(status, 200);
    assert.equal(header(lines, 'content-type'), 'application/json');
    assert.equal(header(lines, 'x-served-by'), 'mercury');
    assert.equal(header(lines, 'access-control-allow-origin'), '*');
    const data = json(body);
    assert.equal(data.user, 'eric');
    assert.equal(data.q, 'hello world');
    assert.equal(data.method, 'GET');
    assert.ok(data.my_cid);
    assert.equal(data.my_cid, header(lines, 'x-correlation-id'));
  });

  test('the response echoes an inbound correlation id', async () => {
    const { status, lines, body } = await exchange(`${base}/api/echo/eric`, 'GET', { 'X-Correlation-Id': 'cid-echo-0101' });
    assert.equal(status, 200);
    assert.equal(header(lines, 'x-correlation-id'), 'cid-echo-0101');
    assert.equal(json(body).my_cid, 'cid-echo-0101');
  });

  test('POST with a JSON body', async () => {
    const { status, body } = await exchange(`${base}/api/echo/poster`, 'POST',
      { 'Content-Type': 'application/json', 'X-Correlation-Id': 'order-777' }, '{"item":"book","qty":2}');
    assert.equal(status, 200);
    const data = json(body);
    assert.deepEqual(data.echo_body, { item: 'book', qty: 2 });
    assert.equal(data.my_cid, 'order-777');
  });

  test('the body dispatch mirrors the content-type rules', async () => {
    const probeBody = async (headers: Record<string, string>, data: string): Promise<Json> => {
      const { status, body } = await exchange(`${base}/api/probe`, 'POST', headers, data);
      assert.equal(status, 200, body.toString());
      return json(body);
    };
    assert.equal((await probeBody({ 'Content-Type': 'application/json' }, '{"item":"book"}')).kind, 'map');
    const mislabelled = await probeBody({ 'Content-Type': 'application/json' }, 'import graph from tutorial-1');
    assert.equal(mislabelled.kind, 'text');
    assert.equal(mislabelled.content, 'import graph from tutorial-1');
    const empty = await probeBody({ 'Content-Type': 'application/json' }, '');
    assert.equal(empty.kind, 'map');
    assert.deepEqual(empty.content, {});
    assert.equal((await probeBody({ 'Content-Type': 'text/plain' }, '{"item":"book"}')).kind, 'text');
    const form = await probeBody({ 'Content-Type': 'application/x-www-form-urlencoded' }, 'a=1&b=hello+world');
    assert.equal(form.kind, 'null');
    assert.deepEqual(form.query, { a: '1', b: 'hello world' });
    const raw = await probeBody({}, '{"item":"book"}');
    assert.equal(raw.kind, 'bytes');
    assert.equal(raw.content, '{"item":"book"}');
  });

  test("an unknown path is the engines' 404", async () => {
    const { status, lines, body } = await exchange(`${base}/api/nowhere`);
    assert.equal(status, 404);
    assert.equal(header(lines, 'content-type'), 'application/json');
    assert.deepEqual(json(body), { status: 404, message: 'Resource not found', type: 'error' });
  });

  test('an entry without a registered service is skipped at the start', async () => {
    const ghost = await exchange(`${base}/api/ghost`);
    assert.equal(ghost.status, 404);
    assert.equal(json(ghost.body).message, 'Resource not found');
    assert.equal((await exchange(`${base}/api/echo/alice`)).status, 200);
  });

  test('the root falls back to the /index.html entry', async () => {
    const index = await exchange(`${base}/index.html`, 'GET', { Accept: 'text/plain' });
    assert.equal(index.status, 200);
    assert.equal(index.body.toString(), 'plain response');
    const rootPage = await exchange(`${base}/`, 'GET', { Accept: 'text/plain' });
    assert.equal(rootPage.status, 200);
    assert.equal(rootPage.body.toString(), index.body.toString());
  });

  test('a returned envelope sets the status and the headers', async () => {
    const { status, lines, body } = await exchange(`${base}/api/envelope/carol`, 'GET', { Accept: 'application/json' });
    assert.equal(status, 202);
    assert.equal(header(lines, 'x-typed-reply'), 'envelope');
    assert.deepEqual(json(body), { user: 'carol', accepted: true });
  });

  test('a function failure is the standard error body, a JSON-looking one is left alone', async () => {
    const failed = await exchange(`${base}/api/fail`);
    assert.equal(failed.status, 404);
    assert.equal(header(failed.lines, 'content-type'), 'application/json');
    assert.deepEqual(json(failed.body), { status: 404, message: 'nothing here', type: 'error' });
    const custom = await exchange(`${base}/api/fail/json`);
    assert.equal(custom.status, 409);
    assert.equal(custom.body.toString(), '{"custom":true}');
  });

  test('the CORS preflight, and 405 without a CORS block', async () => {
    const preflight = await exchange(`${base}/api/echo/any`, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(header(preflight.lines, 'access-control-allow-origin'), '*');
    assert.ok((header(preflight.lines, 'access-control-allow-methods') ?? '').includes('POST'));
    const refused = await exchange(`${base}/api/text`, 'OPTIONS');
    assert.equal(refused.status, 405);
    assert.equal(json(refused.body).message, 'Method not allowed');
  });

  test('a known path under a wrong method is 405', async () => {
    const { status, body } = await exchange(`${base}/api/text`, 'PUT');
    assert.equal(status, 405);
    assert.equal(json(body).message, 'Method not allowed');
  });

  test('a slow function times out as 408', async () => {
    const { status, body } = await exchange(`${base}/api/slow`);
    assert.equal(status, 408);
    assert.deepEqual(json(body), { status: 408, message: 'Timeout for 1000 ms', type: 'error' });
  });

  test('the authentication gate and the session map, and a built-in behind it', async () => {
    const refused = await exchange(`${base}/api/secure`);
    assert.equal(refused.status, 401);
    assert.equal(json(refused.body).message, 'Unauthorized');
    const allowed = await exchange(`${base}/api/secure`, 'GET', { 'X-Api-Key': 'open-sesame' });
    assert.equal(allowed.status, 200);
    assert.deepEqual(json(allowed.body).session, { user: 'demo' });
    // a built-in service behind the entry's authentication
    assert.equal((await exchange(`${base}/ops/info`)).status, 401);
    const info = await exchange(`${base}/ops/info`, 'GET', { 'X-Api-Key': 'open-sesame' });
    assert.equal(info.status, 200);
    assert.ok('app' in json(info.body));
  });

  test("the edge starts the trace and adopts the traceparent's parent", async () => {
    const upstreamTrace = '4bf92f3577b34da6a3ce929d0e0e4736';
    const upstreamSpan = '00f067aa0ba902b7';
    const { status } = await exchange(`${base}/api/traced?flag=on`, 'GET',
      { traceparent: `00-${upstreamTrace}-${upstreamSpan}-01`, 'X-Correlation-Id': 'biz-9' });
    assert.equal(status, 200);
    assert.deepEqual(probe.trace, [upstreamTrace, 'GET /api/traced?flag=on', 'biz-9']);
    await waitFor(() => {
      const services = new Set(probe.datasets.map((d) => d.trace.service));
      return services.has('http.request') && services.has('trace.probe');
    });
    const edge = probe.datasets.find((d) => d.trace.service === 'http.request')!.trace;
    const fn = probe.datasets.find((d) => d.trace.service === 'trace.probe')!.trace;
    assert.equal(edge.id, upstreamTrace);
    assert.equal(edge.parent_span_id, upstreamSpan);
    assert.equal(edge.path, 'GET /api/traced?flag=on');
    assert.equal(edge.status, 200);
    assert.equal(edge.success, true);
    assert.ok(!('from' in edge));
    assert.equal(fn.parent_span_id, edge.span_id);
    assert.equal(fn.from, 'http.request');
    assert.equal(fn.path, 'GET /api/traced?flag=on');
    assert.ok('round_trip' in fn);
  });

  test('content negotiation', async () => {
    const plain = await exchange(`${base}/api/text`, 'GET', { Accept: 'text/plain' });
    assert.equal(plain.status, 200);
    assert.equal(header(plain.lines, 'content-type'), 'text/plain');
    assert.equal(plain.body.toString(), 'plain response');
    const any = await exchange(`${base}/api/text`, 'GET', { Accept: '*/*' });
    assert.equal(header(any.lines, 'content-type'), 'application/json');
    assert.equal(any.body.toString(), 'plain response');
    const html = await exchange(`${base}/api/echo/html?q=1`, 'GET', { Accept: 'text/html' });
    assert.equal(header(html.lines, 'content-type'), 'text/html');
    assert.ok(html.body.toString().startsWith('<html><body><pre>\n'));
    assert.ok(html.body.toString().endsWith('\n</pre></body></html>'));
    const none = await exchange(`${base}/api/text`);
    assert.equal(header(none.lines, 'content-type'), undefined);
    assert.equal(none.body.toString(), 'plain response');
  });

  test("the request model matches the engines' keys", async () => {
    const { status, body } = await exchange(`${base}/api/request/view?q=a&q=b&single=1`, 'GET',
      { Accept: 'application/json', Cookie: 'first=alpha; second=beta', 'X-Forwarded-Proto': 'https' });
    assert.equal(status, 200);
    const data = json(body);
    assert.deepEqual(data.q, ['a', 'b']);
    assert.equal(data.single, '1');
    assert.equal(data.cookie_first, 'alpha');
    assert.equal(data.cookie_second, 'beta');
    assert.ok(!('cookie_header' in data)); // a null entry is omitted from the JSON
    assert.equal(data.query, 'q=a&q=b&single=1');
    assert.equal(data.https, true);
    assert.equal(data.ip, '127.0.0.1');
    assert.equal(data.timeout, 30);
  });

  test('the wildcard grammar', async () => {
    const accept = { Accept: '*/*' };
    assert.equal((await exchange(`${base}/api/files/a/b`, 'GET', accept)).status, 200);
    assert.equal((await exchange(`${base}/api/files`, 'GET', accept)).status, 404);
    assert.equal((await exchange(`${base}/api/v2/ping`, 'GET', accept)).status, 200);
    assert.equal((await exchange(`${base}/api/mid/x/end`, 'GET', accept)).status, 200);
    assert.equal((await exchange(`${base}/api/mid/end`, 'GET', accept)).status, 404);
  });

  test('the traceparent header names', async () => {
    // the custom global name (http.traceparent.header) delivers the context when the standard is absent
    const custom: string = '1af92f3577b34da6a3ce929d0e0e4701';
    await exchange(`${base}/api/traced`, 'GET', { 'X-Trace-Context': `00-${custom}-00f067aa0ba902b7-01` });
    assert.equal(probe.trace?.[0], custom);
    // the standard traceparent wins over the custom name
    const standard: string = '3af92f3577b34da6a3ce929d0e0e4703';
    await exchange(`${base}/api/traced`, 'GET', {
      'X-Trace-Context': '00-2af92f3577b34da6a3ce929d0e0e4702-00f067aa0ba902b7-01',
      traceparent: `00-${standard}-00f067aa0ba902b8-01`
    });
    assert.equal(probe.trace?.[0], standard);
    // the per-endpoint override beats the global name
    const endpoint: string = '5af92f3577b34da6a3ce929d0e0e4705';
    await exchange(`${base}/api/renamed/traceparent/probe`, 'GET', {
      'X-Endpoint-Trace': `00-${endpoint}-00f067aa0ba902b7-01`,
      'X-Trace-Context': '00-6af92f3577b34da6a3ce929d0e0e4706-00f067aa0ba902b8-01'
    });
    assert.equal(probe.trace?.[0], endpoint);
    // no header at all: a fresh trace id, 32 hex
    await exchange(`${base}/api/traced`);
    assert.equal(probe.trace?.[0]?.length, 32);
  });

  test("the endpoint's timeout rides the request as x-ttl", async () => {
    const stamped = await exchange(`${base}/api/echo/headers`, 'GET', { Accept: 'application/json' });
    assert.equal(json(stamped.body).headers['x-ttl'], '5000');
    const sent = await exchange(`${base}/api/echo/headers`, 'GET', { Accept: 'application/json', 'x-ttl': '1500' });
    assert.equal(json(sent.body).headers['x-ttl'], '1500');
  });

  test('a stream renders Server-Sent Events', async () => {
    const { status, lines, body } = await exchange(`${base}/api/stream`, 'POST', { Accept: 'text/event-stream' });
    assert.equal(status, 200);
    assert.equal(header(lines, 'content-type'), 'text/event-stream');
    assert.equal(header(lines, 'cache-control'), 'no-cache');
    assert.equal(header(lines, 'x-served-by'), 'mercury');
    assert.ok(header(lines, 'x-correlation-id'));
    const text = body.toString('utf-8');
    assert.ok(text.includes('data: hello\n\n'));
    assert.ok(text.includes('event: tokens\ndata: {"n":2}\n\n'));
    assert.ok(text.endsWith('event: done\ndata: {"usage":1}\n\n'));
  });

  test('a stream renders chunked text without SSE', async () => {
    // the head's content type wins over Accept: an SSE head stays SSE under */*
    const sse = await exchange(`${base}/api/stream`, 'POST', { Accept: '*/*' });
    assert.equal(sse.status, 200);
    assert.equal(header(sse.lines, 'content-type'), 'text/event-stream');
    // a JSON head renders chunked: text verbatim, a structure as one JSON line, no done frame
    const { status, lines, body } = await exchange(`${base}/api/stream/lines`, 'POST', { Accept: '*/*' });
    assert.equal(status, 200);
    assert.equal(header(lines, 'content-type'), 'application/json');
    assert.equal(body.toString(), 'hello{"n":2}\n');
  });

  test('a stream failure in band', async () => {
    const { status, body } = await exchange(`${base}/api/stream/fail`, 'POST', { Accept: 'text/event-stream' });
    assert.equal(status, 200);
    const text = body.toString('utf-8');
    assert.ok(text.includes('data: partial\n\n'));
    assert.ok(text.endsWith('event: error\ndata: {"status":503,"message":"upstream down","type":"error"}\n\n'));
  });

  test('a streaming function without the stream flag answers single-shot', async () => {
    const { status, lines, body } = await exchange(`${base}/api/stream/single`, 'POST', { Accept: 'text/plain' });
    assert.equal(status, 200);
    // the first event completes the exchange (the engines' rule): the head's content type and the
    // first segment's text, nothing more
    assert.equal(header(lines, 'content-type'), 'text/event-stream');
    assert.equal(body.toString(), 'hello');
  });

  test("the default entries serve the host's paths", async () => {
    const event = new EventEnvelope('plain.text');
    const response = await fetch(`${base}/api/event`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-ttl': '5000' }, body: event.toBytes()
    });
    assert.equal(response.status, 200);
    const reply = EventEnvelope.fromBytes(new Uint8Array(await response.arrayBuffer()));
    assert.equal(reply.body, 'plain response');
    const info = await exchange(`${base}/info`);
    assert.equal(info.status, 200);
    assert.ok('app' in json(info.body));
    assert.equal((await exchange(`${base}/livenessprobe`)).status, 200);
  });

  // ---- upload: the bounded form of the engines' streaming upload ----

  test('a multipart upload delivers the files and the fields', async () => {
    const { status, body } = await postForm(`${base}/api/upload`, form());
    assert.equal(status, 200, body.toString());
    const data = json(body);
    assert.deepEqual(data.files, [
      { name: 'report.pdf', type: 'application/pdf', size: PDF_BYTES.length, tag: 'doc', sha256: sha256(PDF_BYTES) },
      { name: 'page.png', type: 'image/png', size: PNG_BYTES.length, tag: 'image', sha256: sha256(PNG_BYTES) }
    ]);
    assert.deepEqual(data.query, { note: 'hello world' });
    assert.equal(data.size, PDF_BYTES.length + PNG_BYTES.length);
    assert.equal(data.is_file, true);
    assert.equal(data.body_present, false);
  });

  test('a JSON post to an upload entry dispatches as usual', async () => {
    const { status, body } = await exchange(`${base}/api/upload`, 'POST', { 'Content-Type': 'application/json' }, '{"a": 1}');
    assert.equal(status, 200);
    const data = json(body);
    assert.deepEqual(data.files, []);
    assert.equal(data.is_file, false);
    assert.equal(data.body_present, true);
  });

  test('multipart to an entry without upload is bytes', async () => {
    const { status, body } = await postForm(`${base}/api/probe`, form());
    assert.equal(status, 200);
    const data = json(body);
    assert.equal(data.kind, 'bytes');
    assert.ok(String(data.content).includes('report.pdf'));
  });
});

const PDF_BYTES = Buffer.from('%PDF-1.4 a small document');
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(' a small image')]);
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function form(): FormData {
  const data = new FormData();
  data.append('doc', new Blob([PDF_BYTES], { type: 'application/pdf' }), 'report.pdf');
  data.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'page.png');
  data.append('note', 'hello world');
  return data;
}

/** The form as a multipart body - encoded by the runtime, posted without a library. */
async function postForm(url: string, data: FormData): Promise<Exchange> {
  const encoded = new Response(data);
  const body = Buffer.from(await encoded.arrayBuffer());
  return exchange(url, 'POST', { 'Content-Type': encoded.headers.get('content-type')! }, body);
}

const DEFAULT_OVERRIDE_YAML = `rest:
  - service: "event.api.service"
    methods: ['POST']
    url: "/api/event"
    timeout: 60s
    cors: cors_1
    tracing: true
cors:
  - id: cors_1
    options:
      - "Access-Control-Allow-Origin: *"
    headers:
      - "Access-Control-Allow-Origin: *"
`;

test('a user entry overrides a default and adds CORS', async () => {
  configured(DEFAULT_OVERRIDE_YAML);
  const served = await start(buildRegistry(new Probe()));
  try {
    const response = await fetch(`${served.base}/api/event`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new EventEnvelope('plain.text').toBytes()
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const preflight = await exchange(`${served.base}/api/event`, 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.equal(header(preflight.lines, 'access-control-allow-origin'), '*');
    // the other defaults are still merged
    assert.equal((await exchange(`${served.base}/health`)).status, 200);
  } finally {
    await served.stop();
    loadConfig();
  }
});

test('rest.automation off leaves the host unchanged', async () => {
  configured(REST_YAML, { 'rest.automation': false });
  const registry = buildRegistry(new Probe());
  const served = await start(registry);
  try {
    assert.equal(served.api.rest, undefined);
    const { status, body } = await exchange(`${served.base}/api/echo/eric`);
    assert.equal(status, 404);
    assert.equal(json(body).message, 'Resource not found');
  } finally {
    await served.stop();
    loadConfig();
  }
});

test('a missing rest.yaml serves the defaults only', async () => {
  configured(undefined);
  const served = await start(buildRegistry(new Probe()));
  try {
    assert.ok(served.api.rest);
    assert.deepEqual(served.api.rest.table.routes.map((r) => r.url).sort(),
      ['/api/event', '/info', '/info/routes', '/env', '/health', '/livenessprobe'].sort());
    assert.equal((await exchange(`${served.base}/info`)).status, 200);
  } finally {
    await served.stop();
    loadConfig();
  }
});

test('an invalid rest.yaml fails the start', () => {
  configured("rest:\n  - service: http.flow.adapter\n    flow: demo\n    methods: ['GET']\n    url: /x\n");
  try {
    assert.throws(() => new EventApiServer(buildRegistry(new Probe())), (e: unknown) => {
      assert.ok(e instanceof AppException);
      assert.ok(e.message.includes('flow binding is not available in a language pack'), e.message);
      return true;
    });
  } finally {
    loadConfig();
  }
});

test('the file: location form', () => {
  const elsewhere = path.join(root, 'elsewhere', 'routes.yaml');
  write(elsewhere, "rest:\n  - service: plain.text\n    methods: ['GET']\n    url: /elsewhere\n");
  configured(undefined, { 'yaml.rest.automation': `file:${elsewhere}` });
  try {
    const api = new EventApiServer(buildRegistry(new Probe()));
    assert.ok(api.rest);
    assert.ok(api.rest.table.hasUrl('/elsewhere'));
  } finally {
    loadConfig();
  }
});

const EXTENSION_YAML = `rest:
  - service: "plain.text"
    methods: ['GET']
    url: "/ext/claimed"
`;

test("entries win over an extension's routes and over files", async () => {
  configured(EXTENSION_YAML, {}, {
    'index.html': '<h1>bundle</h1>', 'about.html': '<h1>about</h1>', 'style.css': 'body {}',
    'ext/claimed': "a file at an entry's path"
  });
  const mount: RouteMounter = async (_req, res, url) => {
    if (url.pathname === '/ext/claimed' || url.pathname === '/ext/free') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(url.pathname === '/ext/claimed' ? 'extension' : 'extension free');
      return true;
    }
    return false;
  };
  const served = await start(buildRegistry(new Probe()), [mount]);
  try {
    assert.equal((await exchange(`${served.base}/ext/claimed`, 'GET', { Accept: 'text/plain' })).body.toString(), 'plain response');
    assert.equal((await exchange(`${served.base}/ext/free`)).body.toString(), 'extension free');
    const about = await exchange(`${served.base}/about.html`);
    assert.equal(about.status, 200);
    assert.equal(about.body.toString(), '<h1>about</h1>');
  } finally {
    await served.stop();
    loadConfig();
  }
});

const STATIC_YAML = `rest:
  - service: "plain.text"
    methods: ['GET']
    url: "/api/text"
static-content:
  no-cache-pages: ["/", "/index.html"]
  filter:
    path: ["/", "/private/*", "*.html"]
    exclusion: ["*.css"]
    service: "http.request.filter"
`;

test('the static-content filter and the no-cache pages', async () => {
  configured(STATIC_YAML, {}, {
    'index.html': '<h1>bundle</h1>', 'about.html': '<h1>about</h1>', 'style.css': 'body {}',
    'private/page.html': '<h1>private</h1>'
  });
  const registry = buildRegistry(new Probe());
  const seen: Json[] = [];
  registry.register('http.request.filter', async (_headers, body) => {
    const request = new AsyncHttpRequest(body);
    seen.push(request.toMap());
    if (request.url.startsWith('/private/')) {
      return new EventEnvelope().setStatus(302).setHeader('Location', '/login');
    }
    return new EventEnvelope().setHeader('x-filter', 'demo');
  });
  const served = await start(registry);
  try {
    const about = await exchange(`${served.base}/about.html`);
    assert.equal(about.status, 200);
    assert.equal(about.body.toString(), '<h1>about</h1>');
    assert.equal(header(about.lines, 'x-filter'), 'demo');
    assert.ok(header(about.lines, 'etag'));
    assert.equal(header(about.lines, 'pragma'), undefined);
    const last = seen.at(-1)!;
    assert.equal(last.method, 'GET');
    assert.equal(last.url, '/about.html');
    assert.equal(last.body, null);
    assert.ok('headers' in last);
    const css = await exchange(`${served.base}/style.css`);
    assert.equal(css.status, 200);
    assert.equal(header(css.lines, 'x-filter'), undefined);
    const priv = await exchange(`${served.base}/private/page.html`);
    assert.equal(priv.status, 302);
    assert.equal(header(priv.lines, 'location'), '/login');
    assert.equal(priv.body.length, 0);
    const index = await exchange(`${served.base}/`);
    assert.equal(index.status, 200);
    assert.equal(index.body.toString(), '<h1>bundle</h1>');
    assert.equal(header(index.lines, 'cache-control'), 'no-cache, no-store');
    assert.equal(header(index.lines, 'pragma'), 'no-cache');
    assert.equal(header(index.lines, 'expires'), 'Thu, 01 Jan 1970 00:00:00 GMT');
    const text = await exchange(`${served.base}/api/text`, 'GET', { Accept: 'text/plain' });
    assert.equal(text.status, 200);
    assert.equal(text.body.toString(), 'plain response');
    const missing = await exchange(`${served.base}/missing.html`);
    assert.equal(missing.status, 404);
    assert.equal(json(missing.body).message, 'Resource not found');
  } finally {
    await served.stop();
    loadConfig();
  }
});

test('cors lines resolve configuration references', () => {
  process.env.REST_TEST_ORIGIN = 'https://app.example';
  try {
    configured(REST_YAML.replace('${api.origin:*}', '${REST_TEST_ORIGIN:*}'));
    const api = new EventApiServer(buildRegistry(new Probe()));
    assert.ok(api.rest);
    const entry = api.rest.table.find('GET', '/api/echo/x');
    assert.ok(entry?.info.cors);
    assert.deepEqual(entry.info.cors.headers, [['Access-Control-Allow-Origin', 'https://app.example']]);
  } finally {
    delete process.env.REST_TEST_ORIGIN;
    loadConfig();
  }
});

test('an upload over the bound is 413', async () => {
  configured(REST_YAML, { 'rest.upload.max.bytes': 40 });
  const served = await start(buildRegistry(new Probe()));
  try {
    const { status, body } = await postForm(`${served.base}/api/upload`, form());
    assert.equal(status, 413);
    assert.deepEqual(json(body), { status: 413, message: 'Upload exceeds 40 bytes', type: 'error' });
  } finally {
    await served.stop();
    loadConfig();
  }
});

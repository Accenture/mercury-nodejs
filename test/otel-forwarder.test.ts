/**
 * The OpenTelemetry forwarder: the OTLP protobuf wire format, the dataset -> span
 * mapping, the exporter's retry and diagnostics against a mock collector, and the
 * host hook that hands every emitted dataset to the extension route - the Node.js
 * twin of the engines' forwarder tests.
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { after, before, test } from 'node:test';
import { AppConfig } from '../src/config.js';
import {
  activate, attribute, describeHttpFailure, DISTRIBUTED_TRACE_FORWARDER, encodeExportRequest,
  Exporter, ExportFailure, fixedSettings, INSTRUMENTATION_SCOPE, parseHeaders,
  parseIso8601Nanos, partialSuccess, ProtoReader, ProtoWriter, settingsFromConfig,
  SPAN_FLAGS_SAMPLED_LOCAL, spanFromDataset
} from '../src/otel/index.js';
import { KIND_INTERNAL, KIND_SERVER, STATUS_ERROR, STATUS_OK } from '../src/otel/span.js';
import { WIRE_LEN, WIRE_VARINT } from '../src/otel/otlp.js';
import { FunctionRegistry } from '../src/registry.js';
import { VERSION } from '../src/version.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const PARENT_SPAN_ID = 'b7ad6b7169203331';
const FAST_BACKOFF = [10, 10, 10, 10];

function sampleDataset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const trace: Record<string, unknown> = {
    origin: 'node-1', id: TRACE_ID, path: '/api/hello', service: 'hello.world',
    start: '2026-06-24T10:00:00.000Z', success: true, from: 'http.request',
    exec_time: 12.5, status: 200, span_id: SPAN_ID, parent_span_id: PARENT_SPAN_ID, ...overrides
  };
  return { trace, annotations: { user: 'alice' } };
}

// ---------------------------------------------------------------------------
// a decoding test collector (the twin of the engines' test collectors)
// ---------------------------------------------------------------------------

interface DecodedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startUnixNano: bigint; endUnixNano: bigint; flags: number; statusCode: number;
  statusMessage: string; attributes: Record<string, string>;
}
interface DecodedRequest {
  serviceName?: string; scopeName?: string; scopeVersion?: string; spans: DecodedSpan[];
}

function readKeyValue(body: Uint8Array): [string, string] {
  const r = new ProtoReader(body);
  let key = '';
  let value = '';
  while (r.hasMore()) {
    const [f, w] = r.readTag() ?? [0, 0];
    if (f === 1) {
      key = r.readString() ?? '';
    } else if (f === 2) {
      const inner = new ProtoReader(r.readBytes() ?? new Uint8Array());
      while (inner.hasMore()) {
        const [vf, vw] = inner.readTag() ?? [0, 0];
        if (vf === 1) value = inner.readString() ?? '';
        else if (vf === 2) value = inner.readVarint() ? 'true' : 'false';
        else if (vf === 3) value = String(inner.readVarint());
        else if (vf === 4) value = String(inner.readDouble());
        else inner.skip(vw);
      }
    } else {
      r.skip(w);
    }
  }
  return [key, value];
}

function readSpan(body: Uint8Array): DecodedSpan {
  const r = new ProtoReader(body);
  const span: DecodedSpan = { traceId: '', spanId: '', name: '', kind: 0, startUnixNano: 0n,
                              endUnixNano: 0n, flags: 0, statusCode: 0, statusMessage: '',
                              attributes: {} };
  const hexOf = (b: Uint8Array | undefined): string => Buffer.from(b ?? []).toString('hex');
  while (r.hasMore()) {
    const [f, w] = r.readTag() ?? [0, 0];
    switch (f) {
      case 1: span.traceId = hexOf(r.readBytes()); break;
      case 2: span.spanId = hexOf(r.readBytes()); break;
      case 4: span.parentSpanId = hexOf(r.readBytes()); break;
      case 5: span.name = r.readString() ?? ''; break;
      case 6: span.kind = Number(r.readVarint() ?? 0n); break;
      case 7: span.startUnixNano = r.readFixed64() ?? 0n; break;
      case 8: span.endUnixNano = r.readFixed64() ?? 0n; break;
      case 9: {
        const [key, value] = readKeyValue(r.readBytes() ?? new Uint8Array());
        span.attributes[key] = value;
        break;
      }
      case 15: {
        const inner = new ProtoReader(r.readBytes() ?? new Uint8Array());
        while (inner.hasMore()) {
          const [sf, sw] = inner.readTag() ?? [0, 0];
          if (sf === 2) span.statusMessage = inner.readString() ?? '';
          else if (sf === 3) span.statusCode = Number(inner.readVarint() ?? 0n);
          else inner.skip(sw);
        }
        break;
      }
      case 16: span.flags = r.readFixed32() ?? 0; break;
      default: r.skip(w);
    }
  }
  return span;
}

function decodeRequest(body: Uint8Array): DecodedRequest {
  const out: DecodedRequest = { spans: [] };
  const r = new ProtoReader(body);
  while (r.hasMore()) {
    const [f, w] = r.readTag() ?? [0, 0];
    if (f !== 1) { r.skip(w); continue; }
    const rs = new ProtoReader(r.readBytes() ?? new Uint8Array());
    while (rs.hasMore()) {
      const [rf, rw] = rs.readTag() ?? [0, 0];
      if (rf === 1) {
        const res = new ProtoReader(rs.readBytes() ?? new Uint8Array());
        while (res.hasMore()) {
          const [af, aw] = res.readTag() ?? [0, 0];
          if (af === 1) {
            const [key, value] = readKeyValue(res.readBytes() ?? new Uint8Array());
            if (key === 'service.name') out.serviceName = value;
          } else {
            res.skip(aw);
          }
        }
      } else if (rf === 2) {
        const ss = new ProtoReader(rs.readBytes() ?? new Uint8Array());
        while (ss.hasMore()) {
          const [sf, sw] = ss.readTag() ?? [0, 0];
          if (sf === 1) {
            const scope = new ProtoReader(ss.readBytes() ?? new Uint8Array());
            while (scope.hasMore()) {
              const [cf, cw] = scope.readTag() ?? [0, 0];
              if (cf === 1) out.scopeName = scope.readString();
              else if (cf === 2) out.scopeVersion = scope.readString();
              else scope.skip(cw);
            }
          } else if (sf === 2) {
            out.spans.push(readSpan(ss.readBytes() ?? new Uint8Array()));
          } else {
            ss.skip(sw);
          }
        }
      } else {
        rs.skip(rw);
      }
    }
  }
  return out;
}

interface Captured { path: string; headers: Record<string, string>; request: DecodedRequest; }

class MockCollector {
  captured: Captured[] = [];
  script: Array<[number, string]> = [];
  requests = 0;
  private server?: http.Server;
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests += 1;
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
        this.captured.push({ path: req.url ?? '', headers,
                             request: decodeRequest(new Uint8Array(Buffer.concat(chunks))) });
        const scripted = this.script.shift();
        res.statusCode = scripted ? scripted[0] : 200;
        res.end(scripted ? scripted[1] : '');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }
}

const collector = new MockCollector();
before(() => collector.start());
after(() => collector.stop());

function exporterFor(path: string, headers: Array<[string, string]>,
                     serviceName = 'mercury-otel-demo'): Exporter {
  return new Exporter(fixedSettings(collector.url(path), { timeoutMs: 2000, headers, serviceName }),
                      FAST_BACKOFF);
}

function configWith(keys: Record<string, string>): AppConfig {
  const config = new AppConfig(undefined, []);
  for (const [key, value] of Object.entries(keys)) config.set(key, value);
  return config;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// headers, mapping, encoding
// ---------------------------------------------------------------------------

test('header parsing accepts both forms and keeps tokens whole', () => {
  assert.deepEqual(parseHeaders(undefined), []);
  assert.deepEqual(parseHeaders('  '), []);
  assert.deepEqual(parseHeaders('null'), []);
  assert.deepEqual(parseHeaders('Authorization=Api-Token abc=def, X-Tenant: t=1'),
    [['Authorization', 'Api-Token abc=def'], ['X-Tenant', 't=1']]);
  assert.deepEqual(parseHeaders('Authorization: Api-Token x:y'), [['Authorization', 'Api-Token x:y']]);
  // a repeated name keeps the last value; a pair without a separator is dropped
  assert.deepEqual(parseHeaders('a=1,a=2,junk,=nokey'), [['a', '2']]);
});

test('span mapping preserves the ids and the metrics', () => {
  const span = spanFromDataset(sampleDataset());
  assert.ok(span);
  assert.equal(Buffer.from(span.traceId).toString('hex'), TRACE_ID);
  assert.equal(Buffer.from(span.spanId).toString('hex'), SPAN_ID);
  assert.equal(Buffer.from(span.parentSpanId!).toString('hex'), PARENT_SPAN_ID);
  assert.equal(span.name, 'hello.world');
  assert.equal(span.kind, KIND_SERVER);
  assert.equal(span.statusCode, STATUS_OK);
  assert.equal(span.startUnixNano, 1_782_295_200_000_000_000n);
  assert.equal(span.endUnixNano - span.startUnixNano, 12_500_000n);
  assert.equal(attribute(span, 'route'), 'hello.world');
  assert.equal(attribute(span, 'path'), '/api/hello');
  assert.equal(attribute(span, 'from'), 'http.request');
  assert.equal(attribute(span, 'origin'), 'node-1');
  assert.equal(attribute(span, 'status'), '200');
  assert.equal(attribute(span, 'exec_time_ms'), '12.5');
  assert.equal(attribute(span, 'annotation.user'), 'alice');
});

test('span mapping: failure, root span and internal kind', () => {
  const dataset = sampleDataset({ success: false, exception: 'boom', status: 500,
                                  parent_span_id: undefined, from: 'hello.caller' });
  const span = spanFromDataset(dataset);
  assert.ok(span);
  assert.equal(span.parentSpanId, undefined);
  assert.equal(span.kind, KIND_INTERNAL);
  assert.equal(span.statusCode, STATUS_ERROR);
  assert.equal(span.statusMessage, 'boom');
  assert.equal(attribute(span, 'exception'), 'boom');
  const span2 = spanFromDataset(sampleDataset({ success: false, status: 503 }));
  assert.ok(span2);
  assert.equal(span2.statusMessage, 'status=503');
});

test('span mapping skips non-W3C ids and shapeless datasets', () => {
  assert.equal(spanFromDataset({ trace: { id: 'not-hex', span_id: SPAN_ID } }), undefined);
  assert.equal(spanFromDataset(sampleDataset({ id: '0'.repeat(32) })), undefined);
  assert.equal(spanFromDataset(sampleDataset({ span_id: 'ABCDEF0123456789' })), undefined);
  assert.equal(spanFromDataset({ annotations: {} }), undefined);
  assert.equal(spanFromDataset('text'), undefined);
});

test('ISO-8601 parsing', () => {
  assert.equal(parseIso8601Nanos('2026-06-24T10:00:00Z'), 1_782_295_200_000_000_000n);
  assert.equal(parseIso8601Nanos('2026-06-24T10:00:00.5Z'), 1_782_295_200_500_000_000n);
  assert.equal(parseIso8601Nanos('1970-01-01T00:00:00.000000001Z'), 1n);
  for (const bad of ['2026-06-24 10:00:00Z', '2026-13-01T00:00:00Z', '2026-06-24T10:00:00',
                     '2026-06-24T10:00:00.Z', '2026-06-24T10:00:00.0123456789Z']) {
    assert.equal(parseIso8601Nanos(bad), undefined, bad);
  }
});

test('encoding round-trips through the reader', () => {
  const span = spanFromDataset(sampleDataset())!;
  const decoded = decodeRequest(encodeExportRequest('svc', INSTRUMENTATION_SCOPE, VERSION, span));
  assert.equal(decoded.serviceName, 'svc');
  assert.equal(decoded.scopeName, INSTRUMENTATION_SCOPE);
  assert.equal(decoded.scopeVersion, VERSION);
  assert.equal(decoded.spans.length, 1);
  const got = decoded.spans[0];
  assert.deepEqual([got.traceId, got.spanId, got.parentSpanId], [TRACE_ID, SPAN_ID, PARENT_SPAN_ID]);
  assert.equal(got.name, 'hello.world');
  assert.equal(got.kind, 2);
  assert.equal(got.statusCode, 1);
  assert.equal(got.flags, SPAN_FLAGS_SAMPLED_LOCAL);
  assert.equal(got.startUnixNano, 1_782_295_200_000_000_000n);
  assert.equal(got.endUnixNano - got.startUnixNano, 12_500_000n);
  assert.equal(got.attributes.status, '200');
  assert.equal(got.attributes.exec_time_ms, '12.5');
  assert.equal(got.attributes['annotation.user'], 'alice');
});

test('partial success reader', () => {
  const inner = new ProtoWriter();
  inner.int64Always(1, 3);
  inner.string(2, '3 spans had no name');
  const w = new ProtoWriter();
  w.message(1, inner.intoBytes());
  assert.deepEqual(partialSuccess(w.intoBytes()), { rejectedSpans: 3, errorMessage: '3 spans had no name' });
  assert.equal(partialSuccess(new Uint8Array()), undefined);
  const empty = new ProtoWriter();
  empty.message(1, new Uint8Array());
  assert.equal(partialSuccess(empty.intoBytes()), undefined);
  // the reader's wire constants are the protobuf ones
  assert.equal(WIRE_VARINT, 0);
  assert.equal(WIRE_LEN, 2);
});

test('failure descriptions carry hints and bound the body', () => {
  assert.ok(describeHttpFailure(401, 'Token   Authentication\nfailed')
    .startsWith('HTTP 401 - Token Authentication failed | the backend rejected'));
  assert.ok(describeHttpFailure(404, '').includes('signal path'));
  assert.ok(describeHttpFailure(500, 'x'.repeat(300)).endsWith('...'));
  assert.equal(describeHttpFailure(418, ''), 'HTTP 418');
});

test('a misconfigured endpoint is refused at construction', () => {
  assert.throws(() => new Exporter(fixedSettings('localhost:4318/v1/traces')), /otel\.exporter\.otlp\.endpoint/);
  assert.throws(() => new Exporter(fixedSettings('ftp://collector/v1/traces')));
});

// ---------------------------------------------------------------------------
// the exporter against the collector
// ---------------------------------------------------------------------------

test('the exporter delivers the span and the credential', async () => {
  for (const path of ['/api/v2/otlp/v1/traces', '/v2/trace/otlp']) {
    collector.captured = [];
    const exporter = exporterFor(path, [['Authorization', 'Api-Token test-secret']]);
    await exporter.export(spanFromDataset(sampleDataset())!);
    assert.equal(collector.captured.length, 1);
    const request = collector.captured[0];
    assert.equal(request.path, path);
    assert.equal(request.headers['content-type'], 'application/x-protobuf');
    assert.equal(request.headers.authorization, 'Api-Token test-secret');
    assert.equal(request.request.serviceName, 'mercury-otel-demo');
    assert.equal(request.request.scopeName, INSTRUMENTATION_SCOPE);
    assert.equal(request.request.scopeVersion, VERSION);
    assert.equal(request.request.spans.length, 1);
    const got = request.request.spans[0];
    assert.deepEqual([got.traceId, got.spanId, got.parentSpanId], [TRACE_ID, SPAN_ID, PARENT_SPAN_ID]);
  }
});

test('transient statuses are retried to success', async () => {
  collector.requests = 0;
  collector.script = [[503, 'busy'], [429, 'slow down']];
  await exporterFor('/v1/traces', []).export(spanFromDataset(sampleDataset())!);
  assert.equal(collector.requests, 3, 'two retryable answers, then the success');
});

test('final rejections are not retried and name their cause', async () => {
  collector.requests = 0;
  collector.script = [[401, 'Token Authentication failed']];
  await assert.rejects(
    exporterFor('/v1/traces', [['Authorization', 'Api-Token wrong']]).export(spanFromDataset(sampleDataset())!),
    (e: unknown) => {
      assert.ok(e instanceof ExportFailure);
      assert.equal(e.attempts, 1);
      assert.ok(e.message.startsWith('HTTP 401 - Token Authentication failed | '), e.message);
      return true;
    });
  assert.equal(collector.requests, 1);
});

test('a refused connection is retried then reported', async () => {
  // nothing listens on port 1: every attempt is a transport failure
  const exporter = new Exporter(fixedSettings('http://127.0.0.1:1/v1/traces', { timeoutMs: 1000 }), [10, 10]);
  await assert.rejects(exporter.export(spanFromDataset(sampleDataset())!), (e: unknown) => {
    assert.ok(e instanceof ExportFailure);
    assert.equal(e.attempts, 3);
    assert.ok(e.message.includes('(after 3 attempts)'), e.message);
    return true;
  });
});

test('the credential is re-read on every export', async () => {
  collector.captured = [];
  const config = configWith({ 'otel.forwarding': 'true',
                              'otel.exporter.otlp.endpoint': collector.url('/v1/traces'),
                              'otel.service.name': 'late-credential-app' });
  const exporter = new Exporter(settingsFromConfig(config), FAST_BACKOFF);
  const span = spanFromDataset(sampleDataset())!;
  assert.deepEqual(exporter.headerNames(), []);
  await exporter.export(span);
  assert.equal(collector.captured[0].headers.authorization, undefined);
  // the credential bootstrap publishes the header after start-up
  config.set('otel.exporter.otlp.headers', 'Authorization=Api-Token published-later');
  await exporter.export(span);
  assert.equal(collector.captured[1].headers.authorization, 'Api-Token published-later');
  assert.equal(collector.captured[1].request.serviceName, 'late-credential-app');
});

// ---------------------------------------------------------------------------
// activation and the host hook
// ---------------------------------------------------------------------------

test('the switch is the only thing that turns it on', () => {
  const registry = new FunctionRegistry();
  assert.equal(activate(configWith({}), registry), undefined);
  assert.equal(activate(configWith({ 'otel.forwarding': 'false' }), registry), undefined);
  assert.equal(registry.exists(DISTRIBUTED_TRACE_FORWARDER), false);
  const exporter = activate(configWith({ 'otel.forwarding': 'true',
                                         'otel.exporter.otlp.endpoint': 'http://127.0.0.1:4318/v1/traces' }),
                            registry);
  assert.ok(exporter);
  const service = registry.get(DISTRIBUTED_TRACE_FORWARDER);
  assert.ok(service);
  assert.equal(service.isPrivate, true);
  assert.equal(service.instances, 2);
  // an application's own forwarder on the route wins
  const other = new FunctionRegistry();
  other.register(DISTRIBUTED_TRACE_FORWARDER, async () => undefined);
  assert.equal(activate(configWith({ 'otel.forwarding': 'true' }), other), undefined);
});

test('a bad endpoint fails the activation', () => {
  assert.throws(() => activate(configWith({ 'otel.forwarding': 'true',
                                            'otel.exporter.otlp.endpoint': 'nowhere' }),
                               new FunctionRegistry()));
});

test('the host hands every dataset to the forwarder', async () => {
  collector.captured = [];
  const registry = new FunctionRegistry();
  const seen: string[] = [];
  const service = registry.register('unit.hello', async (_headers, body) => {
    seen.push(JSON.stringify(body));
    return { ok: true };
  });
  const exporter = activate(configWith({ 'otel.forwarding': 'true',
                                         'otel.exporter.otlp.endpoint': collector.url('/v1/traces'),
                                         'otel.service.name': 'node-host' }), registry);
  assert.ok(exporter);
  try {
    // a traced drop-n-forget execution emits a dataset (an RPC would fold into the caller)
    registry.bus.publish(service, {}, { n: 1 }, { traceId: TRACE_ID, tracePath: 'NODE /test' });
    await waitFor(() => collector.captured.length >= 1);
  } finally {
    registry.bus.close();
  }
  assert.deepEqual(seen, ['{"n":1}']);
  const got = collector.captured[0].request;
  assert.equal(got.serviceName, 'node-host');
  assert.equal(got.spans.length, 1);
  const span = got.spans[0];
  assert.equal(span.traceId, TRACE_ID);
  assert.equal(span.spanId.length, 16);
  assert.equal(span.name, 'unit.hello');
  assert.equal(span.statusCode, 1);
  assert.equal(span.attributes.route, 'unit.hello');
  // the forwarder's own execution is untraced: exactly one span reached the collector
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(collector.captured.length, 1);
});

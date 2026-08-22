/** Codec unit tests: round-trip, omission rules, format detection, conformance vectors. */
import { encode } from '@msgpack/msgpack';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventEnvelope, isoUtc } from '../src/envelope.js';
import { CompactFormatError } from '../src/exceptions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.resolve(here, '../../test/vectors/vectors.json');

test('round trip all fields', () => {
  const event = new EventEnvelope('target.route', { a: 1, b: [1, 2, 3] })
    .setFrom('source.route').setReplyTo('reply.route')
    .setCorrelationId('cid-1').setTrace('trace-1', 'GET /api/x')
    .setStatus(200).setHeader('k1', 'v1');
  event.spanId = 'span-1';
  event.execTime = 1.5;
  event.roundTrip = 2.5;
  event.tags = { rpc: '30000' };
  event.annotations = { note: 'n1' };
  event.stack = 'trace text';
  event.objType = 'com.example.Demo';
  const decoded = EventEnvelope.fromBytes(event.toBytes());
  assert.equal(decoded.to, 'target.route');
  assert.equal(decoded.sender, 'source.route');
  assert.equal(decoded.replyTo, 'reply.route');
  assert.equal(decoded.cid, 'cid-1');
  assert.equal(decoded.traceId, 'trace-1');
  assert.equal(decoded.tracePath, 'GET /api/x');
  assert.equal(decoded.spanId, 'span-1');
  assert.equal(decoded.getStatus(), 200);
  assert.deepEqual(decoded.headers, { k1: 'v1' });
  assert.deepEqual(decoded.body, { a: 1, b: [1, 2, 3] });
  assert.equal(decoded.execTime, 1.5);
  assert.equal(decoded.roundTrip, 2.5);
  assert.deepEqual(decoded.tags, { rpc: '30000' });
  assert.deepEqual(decoded.annotations, { note: 'n1' });
  assert.equal(decoded.stack, 'trace text');
  assert.equal(decoded.objType, 'com.example.Demo');
});

test('unset fields omitted; id and headers always present', () => {
  const wire = new EventEnvelope().toMap();
  assert.deepEqual(Object.keys(wire).sort(), ['headers', 'id']);
});

test('absent and nil equivalent; unknown keys ignored; default status 200', () => {
  const bytes = encode({ id: 'x1', headers: {}, body: null, future_field: 42 });
  const decoded = EventEnvelope.fromBytes(bytes);
  assert.equal(decoded.body, null);
  assert.equal(decoded.getStatus(), 200);
  assert.equal(decoded.id, 'x1');
});

test('compact format detected and rejected', () => {
  const compact = encode({ '0': 'e1', T: 'hello.world' });
  assert.throws(() => EventEnvelope.fromBytes(compact), CompactFormatError);
});

test('binary body', () => {
  const event = new EventEnvelope('bin.route', new Uint8Array([0, 1, 2]));
  const decoded = EventEnvelope.fromBytes(event.toBytes());
  assert.deepEqual(decoded.body, new Uint8Array([0, 1, 2]));
});

test('Date encodes as ISO-8601 UTC string, never a MsgPack extension', () => {
  const moment = new Date('2026-07-21T12:00:00.000Z');
  assert.equal(isoUtc(moment), '2026-07-21T12:00:00.000Z');
  const event = new EventEnvelope('time.route', { when: moment });
  const decoded = EventEnvelope.fromBytes(event.toBytes());
  assert.deepEqual(decoded.body, { when: '2026-07-21T12:00:00.000Z' });
});

interface Vector {
  name: string;
  format: string;
  base64: string;
  expect: Record<string, unknown>;
}

function comparable(value: unknown): unknown {
  // JSON expectations cannot carry BigInt: fold safe BigInt to number for comparison
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(comparable);
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = comparable(v);
    return out;
  }
  return value;
}

test('golden vectors conformance', () => {
  const catalog = JSON.parse(fs.readFileSync(VECTORS, 'utf-8')) as { vectors: Vector[] };
  const standard = catalog.vectors.filter((v) => v.format === 'standard');
  const compact = catalog.vectors.filter((v) => v.format === 'compact');
  assert.ok(standard.length > 0 && compact.length > 0);
  for (const vector of standard) {
    const raw = new Uint8Array(Buffer.from(vector.base64, 'base64'));
    const decoded = EventEnvelope.fromBytes(raw);
    const wire = comparable(decoded.toMap()) as Record<string, unknown>;
    for (const [key, expected] of Object.entries(vector.expect)) {
      assert.deepEqual(wire[key], expected, `${vector.name}: field '${key}'`);
    }
    const again = comparable(
      EventEnvelope.fromBytes(decoded.toBytes()).toMap()) as Record<string, unknown>;
    for (const [key, expected] of Object.entries(vector.expect)) {
      assert.deepEqual(again[key], expected, `${vector.name} re-encoded: field '${key}'`);
    }
  }
  for (const vector of compact) {
    const raw = new Uint8Array(Buffer.from(vector.base64, 'base64'));
    assert.throws(() => EventEnvelope.fromBytes(raw), CompactFormatError, vector.name);
  }
});

test('int64 beyond 2^53 stays exact as BigInt (standard-nested-body long field)', () => {
  const catalog = JSON.parse(fs.readFileSync(VECTORS, 'utf-8')) as { vectors: Vector[] };
  const vector = catalog.vectors.find((v) => v.name === 'standard-nested-body');
  assert.ok(vector, 'standard-nested-body vector present');
  const decoded = EventEnvelope.fromBytes(new Uint8Array(Buffer.from(vector!.base64, 'base64')));
  const body = decoded.body as Record<string, unknown>;
  // 9007199254740993 = 2^53 + 1: JSON.parse would corrupt it, BigInt keeps it exact
  assert.equal(body.long, 9007199254740993n);
  const roundTrip = EventEnvelope.fromBytes(decoded.toBytes()).body as Record<string, unknown>;
  assert.equal(roundTrip.long, 9007199254740993n);
});

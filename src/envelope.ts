/**
 * EventEnvelope and the standard wire format codec.
 *
 * Implements the language-neutral standard format from the Mercury Composable
 * "Event Envelope Wire Format" reference: one MsgPack map with descriptive
 * string keys, no MsgPack extension types. Optional fields are omitted when
 * unset; absent and nil are equivalent; unknown keys are ignored; timestamps
 * travel as ISO-8601 UTC strings with millisecond precision.
 *
 * Integer handling: 64-bit integers are decoded exactly — values beyond
 * Number.MAX_SAFE_INTEGER surface as BigInt; smaller ones as number. BigInt
 * values encode as int64.
 *
 * The classic compact format (single-character map keys) is detected from the
 * first map key and rejected with CompactFormatError.
 */
import { Decoder, Encoder } from '@msgpack/msgpack';
import { randomUUID } from 'node:crypto';
import { CompactFormatError } from './exceptions.js';

const encoder = new Encoder({ useBigInt64: true, ignoreUndefined: true });
const decoder = new Decoder({ useBigInt64: true });

/** ISO-8601 UTC with millisecond precision, e.g. 2026-07-21T12:00:00.000Z */
export function isoUtc(date?: Date): string {
  return (date ?? new Date()).toISOString();
}

/** Normalize a payload for the wire: Date -> ISO string, safe BigInt -> number. */
function sanitize(value: unknown): unknown {
  if (value instanceof Date) return isoUtc(value);
  if (typeof value === 'bigint') return value; // encodes exactly as int64
  if (Array.isArray(value)) return value.map(sanitize);
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

/** Decoded values: BigInt within the safe range becomes number. */
function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value) : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Uint8Array) return value;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

/** Render a wire scalar as text: primitives via String, structures via JSON. */
function asText(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function asStringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = asText(v);
    }
  }
  return result;
}

export class EventEnvelope {
  id: string = randomUUID().replaceAll('-', '');
  to?: string;
  sender?: string; // wire field "from"
  replyTo?: string;
  cid?: string;
  traceId?: string;
  tracePath?: string;
  spanId?: string;
  status?: number; // undefined encodes as absent (default 200)
  headers: Record<string, string> = {};
  body: unknown = undefined;
  execTime?: number;
  roundTrip?: number;
  tags: Record<string, string> = {};
  annotations: Record<string, unknown> = {};
  stack?: string;
  objType?: string;
  exception?: Uint8Array; // language-native, opaque here

  constructor(to?: string, body?: unknown, headers?: Record<string, string>) {
    this.to = to;
    this.body = body;
    if (headers) this.headers = { ...headers };
  }

  // fluent helpers mirroring the engine API vocabulary
  setTo(route: string): this { this.to = route; return this; }
  setFrom(route: string): this { this.sender = route; return this; }
  setHeader(key: string, value: unknown): this { this.headers[key] = String(value); return this; }
  setBody(body: unknown): this { this.body = body; return this; }
  setStatus(status: number): this { this.status = Math.trunc(status); return this; }
  setCorrelationId(cid: string): this { this.cid = cid; return this; }
  setTrace(traceId: string, tracePath: string): this {
    this.traceId = traceId;
    this.tracePath = tracePath;
    return this;
  }
  setReplyTo(route?: string): this { this.replyTo = route; return this; }

  getStatus(): number { return this.status ?? 200; }
  hasError(): boolean { return this.getStatus() >= 400; }

  toMap(): Record<string, unknown> {
    const result: Record<string, unknown> = { id: this.id, headers: { ...this.headers } };
    const optional: Array<[string, unknown]> = [
      ['to', this.to], ['from', this.sender], ['reply_to', this.replyTo],
      ['cid', this.cid], ['trace_id', this.traceId], ['trace_path', this.tracePath],
      ['span_id', this.spanId], ['status', this.status], ['body', sanitize(this.body)],
      ['exec_time', this.execTime], ['round_trip', this.roundTrip],
      ['stack', this.stack], ['obj_type', this.objType], ['exception', this.exception]
    ];
    for (const [key, value] of optional) {
      if (value !== undefined && value !== null) result[key] = value;
    }
    if (Object.keys(this.tags).length) result.tags = { ...this.tags };
    if (Object.keys(this.annotations).length) result.annotations = sanitize(this.annotations);
    return result;
  }

  toBytes(): Uint8Array<ArrayBuffer> {
    // fresh copy: the encoder reuses an internal buffer, and a concrete
    // ArrayBuffer-backed Uint8Array satisfies fetch's BodyInit typing
    return new Uint8Array(encoder.encode(this.toMap()));
  }

  /** The optional wire fields that arrive as strings (wire key -> assignment). */
  private static copyStringFields(data: Record<string, unknown>, event: EventEnvelope): void {
    if (typeof data.to === 'string') event.to = data.to;
    if (typeof data.from === 'string') event.sender = data.from;
    if (typeof data.reply_to === 'string') event.replyTo = data.reply_to;
    if (typeof data.cid === 'string') event.cid = data.cid;
    if (typeof data.trace_id === 'string') event.traceId = data.trace_id;
    if (typeof data.trace_path === 'string') event.tracePath = data.trace_path;
    if (typeof data.span_id === 'string') event.spanId = data.span_id;
    if (typeof data.stack === 'string') event.stack = data.stack;
    if (typeof data.obj_type === 'string') event.objType = data.obj_type;
  }

  /** The optional numeric fields (absent and nil are equivalent on the wire). */
  private static copyNumericFields(data: Record<string, unknown>, event: EventEnvelope): void {
    if (data.status !== undefined && data.status !== null) event.status = Number(data.status);
    if (data.exec_time !== undefined && data.exec_time !== null) {
      event.execTime = Number(data.exec_time);
    }
    if (data.round_trip !== undefined && data.round_trip !== null) {
      event.roundTrip = Number(data.round_trip);
    }
  }

  static fromMap(data: Record<string, unknown>): EventEnvelope {
    const event = new EventEnvelope();
    if (data.id !== undefined && data.id !== null) event.id = asText(data.id);
    EventEnvelope.copyStringFields(data, event);
    EventEnvelope.copyNumericFields(data, event);
    event.headers = asStringMap(data.headers);
    if (data.body !== undefined) event.body = normalize(data.body);
    if (data.tags !== undefined && data.tags !== null) event.tags = asStringMap(data.tags);
    if (data.annotations !== undefined && data.annotations !== null) {
      event.annotations = normalize(data.annotations) as Record<string, unknown>;
    }
    if (data.exception instanceof Uint8Array) event.exception = data.exception;
    return event;
  }

  static fromBytes(data: Uint8Array): EventEnvelope {
    let decoded: unknown;
    try {
      decoded = decoder.decode(data);
    } catch (e) {
      throw new Error(`Unable to decode event envelope - ${(e as Error).message}`);
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Unable to decode event envelope - not a MsgPack map');
    }
    const keys = Object.keys(decoded as Record<string, unknown>);
    if (keys.length === 0) {
      throw new Error('Unable to decode event envelope - empty map');
    }
    if (keys[0].length === 1) {
      throw new CompactFormatError(
        'Compact event envelope format is not supported - ' +
        'use the standard format (event.over.http.format=standard)');
    }
    return EventEnvelope.fromMap(decoded as Record<string, unknown>);
  }
}

/**
 * The OTLP wire format - a hand-written protobuf encoder for the one message the
 * forwarder sends, `ExportTraceServiceRequest`, and a reader for the one it
 * receives, `ExportTraceServiceResponse` (the Rust port's `otlp.rs`, line for line).
 *
 * No protobuf library, no generated code, no OpenTelemetry SDK: the OTLP v1 trace
 * schema is frozen and the forwarder needs eight message types with scalar fields.
 * Field numbers are the OTLP trace.proto / common.proto / resource.proto /
 * trace_service.proto definitions; the encoding rules are
 * https://protobuf.dev/programming-guides/encoding/
 *
 *   ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
 *   ResourceSpans   { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
 *   Resource        { repeated KeyValue attributes = 1; }
 *   ScopeSpans      { InstrumentationScope scope = 1; repeated Span spans = 2; }
 *   InstrumentationScope { string name = 1; string version = 2; }
 *   KeyValue        { string key = 1; AnyValue value = 2; }
 *   AnyValue        { oneof value { string string_value = 1; bool bool_value = 2;
 *                                   int64 int_value = 3; double double_value = 4; } }
 *   Span            { bytes trace_id = 1; bytes span_id = 2; bytes parent_span_id = 4;
 *                     string name = 5; SpanKind kind = 6; fixed64 start_time_unix_nano = 7;
 *                     fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9;
 *                     Status status = 15; fixed32 flags = 16; }
 *   Status          { string message = 2; StatusCode code = 3; }
 *   ExportTraceServiceResponse { ExportTracePartialSuccess partial_success = 1; }
 *   ExportTracePartialSuccess  { int64 rejected_spans = 1; string error_message = 2; }
 */
import { AttributeValue, Span, STATUS_UNSET } from './span.js';

// protobuf wire types (the low 3 bits of a field tag)
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

// OTLP span flags: bits 0-7 are the W3C trace flags (0x01 = sampled), bit 8 says
// the is-remote bit is known, bit 9 is the is-remote bit itself. A span this host
// produced is sampled and local - the value the Java SDK writes.
export const SPAN_FLAGS_SAMPLED_LOCAL = 0x0101;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const MASK_64 = (1n << 64n) - 1n;

/**
 * A minimal protobuf writer: field tags, varints, fixed-width scalars and
 * length-delimited payloads. Proto3 default values are omitted, except for
 * `oneof` members (which have explicit presence) - the `*Always` methods.
 */
export class ProtoWriter {
  private chunks: number[] = [];

  intoBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }

  /** Base-128 varint: little-endian groups of 7 bits, high bit = more follows. */
  varint(value: number | bigint): void {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (v < 0n) {
      v &= MASK_64; // two's complement, 64-bit
    }
    for (;;) {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v === 0n) {
        this.chunks.push(byte);
        return;
      }
      this.chunks.push(byte | 0x80);
    }
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  /** `string` - omitted when empty (proto3 default). */
  string(field: number, value: string): void {
    if (value) {
      this.bytes(field, encoder.encode(value));
    }
  }

  /** A `oneof` string member - always written, even when empty. */
  stringAlways(field: number, value: string): void {
    const data = encoder.encode(value);
    this.tag(field, WIRE_LEN);
    this.varint(data.length);
    this.chunks.push(...data);
  }

  /** `bytes` - omitted when empty. */
  bytes(field: number, value: Uint8Array): void {
    if (value.length) {
      this.tag(field, WIRE_LEN);
      this.varint(value.length);
      this.chunks.push(...value);
    }
  }

  /** An embedded message - always written (an empty message is meaningful). */
  message(field: number, body: Uint8Array): void {
    this.tag(field, WIRE_LEN);
    this.varint(body.length);
    this.chunks.push(...body);
  }

  /** `uint32` / `uint64` / enum - omitted when zero. */
  uint(field: number, value: number): void {
    if (value !== 0) {
      this.tag(field, WIRE_VARINT);
      this.varint(value);
    }
  }

  /** A `oneof` `int64` member - always written (two's complement varint). */
  int64Always(field: number, value: number | bigint): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value);
  }

  /** `fixed64` - omitted when zero. */
  fixed64(field: number, value: bigint): void {
    if (value !== 0n) {
      this.tag(field, WIRE_FIXED64);
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigUint64(0, value & MASK_64, true);
      this.chunks.push(...buf);
    }
  }

  /** A `oneof` `double` member - always written (IEEE-754, little-endian). */
  doubleAlways(field: number, value: number): void {
    this.tag(field, WIRE_FIXED64);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, value, true);
    this.chunks.push(...buf);
  }

  /** `fixed32` - omitted when zero. */
  fixed32(field: number, value: number): void {
    if (value !== 0) {
      this.tag(field, WIRE_FIXED32);
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, value, true);
      this.chunks.push(...buf);
    }
  }
}

function anyValue(value: AttributeValue): Uint8Array {
  const w = new ProtoWriter();
  switch (value.type) {
    case 'string':
      w.stringAlways(1, value.value);
      break;
    case 'int':
      w.int64Always(3, value.value);
      break;
    case 'double':
      w.doubleAlways(4, value.value);
      break;
  }
  return w.intoBytes();
}

function keyValue(key: string, value: AttributeValue): Uint8Array {
  const w = new ProtoWriter();
  w.string(1, key);
  w.message(2, anyValue(value));
  return w.intoBytes();
}

function resource(serviceName: string): Uint8Array {
  const w = new ProtoWriter();
  w.message(1, keyValue('service.name', { type: 'string', value: serviceName }));
  return w.intoBytes();
}

function instrumentationScope(name: string, version: string): Uint8Array {
  const w = new ProtoWriter();
  w.string(1, name);
  w.string(2, version);
  return w.intoBytes();
}

function status(span: Span): Uint8Array | undefined {
  if (span.statusCode === STATUS_UNSET && !span.statusMessage) {
    return undefined;
  }
  const w = new ProtoWriter();
  w.string(2, span.statusMessage);
  w.uint(3, span.statusCode);
  return w.intoBytes();
}

/** The OTLP `Span` message for one mapped span. */
export function spanMessage(span: Span): Uint8Array {
  const w = new ProtoWriter();
  w.bytes(1, span.traceId);
  w.bytes(2, span.spanId);
  if (span.parentSpanId) {
    w.bytes(4, span.parentSpanId);
  }
  w.string(5, span.name);
  w.uint(6, span.kind);
  w.fixed64(7, span.startUnixNano);
  w.fixed64(8, span.endUnixNano);
  for (const [key, value] of span.attributes) {
    w.message(9, keyValue(key, value));
  }
  const st = status(span);
  if (st) {
    w.message(15, st);
  }
  w.fixed32(16, SPAN_FLAGS_SAMPLED_LOCAL);
  return w.intoBytes();
}

/**
 * One `ExportTraceServiceRequest` carrying one span under one resource and one
 * instrumentation scope - the request body of an OTLP/HTTP export.
 */
export function encodeExportRequest(serviceName: string, scopeName: string,
                                    scopeVersion: string, span: Span): Uint8Array {
  const scopeSpans = new ProtoWriter();
  scopeSpans.message(1, instrumentationScope(scopeName, scopeVersion));
  scopeSpans.message(2, spanMessage(span));
  const resourceSpans = new ProtoWriter();
  resourceSpans.message(1, resource(serviceName));
  resourceSpans.message(2, scopeSpans.intoBytes());
  const request = new ProtoWriter();
  request.message(1, resourceSpans.intoBytes());
  return request.intoBytes();
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * A minimal, bounds-checked protobuf reader - enough to walk the OTLP message
 * tree (the response's `partial_success`, and the test collector's decoding of
 * what this host sent). Every read returns `undefined` past the end instead of
 * throwing, so a malformed body is reported, never fatal.
 */
export class ProtoReader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  hasMore(): boolean {
    return this.pos < this.buf.length;
  }

  /** The next field tag as `[fieldNumber, wireType]`. */
  readTag(): [number, number] | undefined {
    const tag = this.readVarint();
    if (tag === undefined) {
      return undefined;
    }
    return [Number(tag >> 3n), Number(tag & 0x7n)];
  }

  readVarint(): bigint | undefined {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) {
        return undefined;
      }
      const byte = this.buf[this.pos++];
      if (shift > 63n) {
        return undefined;
      }
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
    }
  }

  readFixed64(): bigint | undefined {
    if (this.pos + 8 > this.buf.length) {
      return undefined;
    }
    const value = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return value;
  }

  readDouble(): number | undefined {
    if (this.pos + 8 > this.buf.length) {
      return undefined;
    }
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }

  readFixed32(): number | undefined {
    if (this.pos + 4 > this.buf.length) {
      return undefined;
    }
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  /** A length-delimited chunk: bytes, a string, or an embedded message. */
  readBytes(): Uint8Array | undefined {
    const length = this.readVarint();
    if (length === undefined) {
      return undefined;
    }
    const n = Number(length);
    if (this.pos + n > this.buf.length) {
      return undefined;
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readString(): string | undefined {
    const data = this.readBytes();
    return data === undefined ? undefined : decoder.decode(data);
  }

  /** Advance past a field whose value is not needed, honouring its wire type. */
  skip(wire: number): boolean {
    switch (wire) {
      case WIRE_VARINT: return this.readVarint() !== undefined;
      case WIRE_FIXED64: return this.readFixed64() !== undefined;
      case WIRE_LEN: return this.readBytes() !== undefined;
      case WIRE_FIXED32: return this.readFixed32() !== undefined;
      default: return false;
    }
  }
}

/**
 * The `partial_success` block of an `ExportTraceServiceResponse`: a backend
 * that accepted the request but rejected spans says so here.
 */
export interface PartialSuccess {
  rejectedSpans: number;
  errorMessage: string;
}

/** The response's partial-success block when it carries content, else undefined. */
export function partialSuccess(body: Uint8Array): PartialSuccess | undefined {
  const reader = new ProtoReader(body);
  let result: PartialSuccess | undefined;
  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) return undefined;
    const [field, wire] = tag;
    if (field === 1 && wire === WIRE_LEN) {
      const block = reader.readBytes();
      if (!block) return undefined;
      const inner = new ProtoReader(block);
      const partial: PartialSuccess = { rejectedSpans: 0, errorMessage: '' };
      while (inner.hasMore()) {
        const innerTag = inner.readTag();
        if (!innerTag) return undefined;
        const [f, w] = innerTag;
        if (f === 1 && w === WIRE_VARINT) {
          const value = inner.readVarint();
          if (value === undefined) return undefined;
          partial.rejectedSpans = Number(BigInt.asIntN(64, value));
        } else if (f === 2 && w === WIRE_LEN) {
          const text = inner.readString();
          if (text === undefined) return undefined;
          partial.errorMessage = text;
        } else if (!inner.skip(w)) {
          return undefined;
        }
      }
      result = partial;
    } else if (!reader.skip(wire)) {
      return undefined;
    }
  }
  if (result && (result.rejectedSpans !== 0 || result.errorMessage)) {
    return result;
  }
  return undefined;
}

/**
 * The forwarder's configuration: the engines' `otel.*` keys, read the engines'
 * way (the Rust port's `config.rs` and `headers.rs`).
 *
 * | Key | Meaning | Default |
 * |-----|---------|---------|
 * | `otel.forwarding` | the master switch | `false` |
 * | `otel.exporter.otlp.endpoint` | the OTLP/HTTP traces URL incl. the signal path | `http://localhost:4318/v1/traces` |
 * | `otel.exporter.otlp.timeout` | per-export timeout, milliseconds | `10000` |
 * | `otel.exporter.otlp.connect.timeout` | no effect here (fetch has one overall timeout) | - |
 * | `otel.exporter.otlp.headers` | request headers: `k=v` or `k: v`, comma list | (none) |
 * | `otel.exporter.otlp.compression` | only `none` is honoured (a warning otherwise) | `none` |
 * | `otel.service.name` | the `service.name` resource attribute | `application.name` |
 */
import type { AppConfig } from '../config.js';
import { getLogger } from '../log.js';
import { VERSION } from '../version.js';

const log = getLogger('mercury.otel');

export const FORWARDING_SWITCH = 'otel.forwarding';
export const ENDPOINT = 'otel.exporter.otlp.endpoint';
export const TIMEOUT = 'otel.exporter.otlp.timeout';
export const CONNECT_TIMEOUT = 'otel.exporter.otlp.connect.timeout';
export const COMPRESSION = 'otel.exporter.otlp.compression';
export const HEADERS = 'otel.exporter.otlp.headers';
export const SERVICE_NAME = 'otel.service.name';
const APP_NAME = 'application.name';
const APP_VERSION = 'info.app.version';

export const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/traces';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_COMPRESSION = 'none';
export const DEFAULT_SERVICE = 'mercury';

/** The request headers, resolved per export. */
export type HeaderSupplier = () => Array<[string, string]>;

export interface ForwarderSettings {
  endpoint: string;
  serviceName: string;
  scopeVersion: string;
  timeoutMs: number;
  compression: string;
  headers: HeaderSupplier;
}

/**
 * Read the `otel.*` keys. Infallible: an unparseable number falls back to its
 * default with a warning; the endpoint URL is validated when the exporter is built.
 */
export function settingsFromConfig(config: AppConfig): ForwarderSettings {
  const serviceName = config.getProperty(SERVICE_NAME) ?? config.getProperty(APP_NAME)
    ?? DEFAULT_SERVICE;
  const endpoint = config.getProperty(ENDPOINT) ?? DEFAULT_ENDPOINT;
  const timeoutMs = millis(config.getProperty(TIMEOUT), TIMEOUT, DEFAULT_TIMEOUT_MS);
  const compression = (config.getProperty(COMPRESSION) ?? '').trim() || DEFAULT_COMPRESSION;
  if (compression.toLowerCase() !== DEFAULT_COMPRESSION) {
    log.warn(`${COMPRESSION}=${compression} is not supported by this host - exporting ` +
      'uncompressed (the payload is one span per request); set none to silence this');
  }
  if (config.exists(CONNECT_TIMEOUT)) {
    log.warn(`${CONNECT_TIMEOUT} has no effect on this host - ${TIMEOUT} bounds the whole ` +
      'export, connect included');
  }
  const scopeVersion = config.getProperty(APP_VERSION) ?? VERSION;
  // read through a supplier so a credential published AFTER this start-up read
  // (a runtime override, the engines' -D / config.set analog a credential
  // bootstrap uses) is picked up rather than frozen out
  const headers = reloadingHeaders(() => config.getProperty(HEADERS));
  return { endpoint, serviceName, scopeVersion, timeoutMs, compression, headers };
}

/** Settings with a FIXED header list - for tests and callers whose credentials are known up front. */
export function fixedSettings(endpoint: string, options: {
  timeoutMs?: number; headers?: Array<[string, string]>; serviceName?: string;
} = {}): ForwarderSettings {
  const fixed = [...(options.headers ?? [])];
  return {
    endpoint,
    serviceName: options.serviceName ?? DEFAULT_SERVICE,
    scopeVersion: VERSION,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    compression: DEFAULT_COMPRESSION,
    headers: () => [...fixed]
  };
}

/**
 * A supplier that re-parses the raw header setting on every call and announces
 * the header NAMES once when they first resolve (never values).
 */
export function reloadingHeaders(raw: () => string | undefined): HeaderSupplier {
  let announced = false;
  return () => {
    const headers = parseHeaders(raw());
    if (headers.length && !announced) {
      announced = true;
      log.info(`OTLP credential header resolved - ${JSON.stringify(headers.map(([k]) => k))}`);
    }
    return headers;
  };
}

/**
 * The OpenTelemetry `key=value,key2=value2` list, also accepting the `key: value`
 * form; the FIRST separator splits, so a token containing `=` or `:` survives; a
 * repeated name keeps its last value.
 */
export function parseHeaders(raw: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (raw === undefined || !raw.trim() || raw.trim() === 'null') {
    return out;
  }
  for (const pair of raw.split(',')) {
    const sep = firstSeparator(pair);
    if (sep === undefined) continue;
    const key = pair.slice(0, sep).trim();
    const value = pair.slice(sep + 1).trim();
    if (!key) continue;
    const existing = out.findIndex(([k]) => k === key);
    if (existing >= 0) {
      out[existing] = [key, value];
    } else {
      out.push([key, value]);
    }
  }
  return out;
}

function firstSeparator(pair: string): number | undefined {
  const eq = pair.indexOf('=');
  const colon = pair.indexOf(':');
  let sep: number;
  if (eq < 0 && colon < 0) return undefined;
  if (eq < 0) sep = colon;
  else if (colon < 0) sep = eq;
  else sep = Math.min(eq, colon);
  return sep > 0 ? sep : undefined;
}

function millis(value: string | undefined, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = Number.parseInt(value.trim(), 10);
  if (Number.isFinite(ms) && ms > 0) return ms;
  log.warn(`${key}=${value} is not a positive number of milliseconds - using ${fallback}`);
  return fallback;
}

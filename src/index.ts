/**
 * Mercury Composable — polyglot functions for Node.js.
 *
 * A lightweight Event-over-HTTP function host and client: write decoupled
 * functions in JavaScript/TypeScript and let Java/Rust Mercury engines
 * orchestrate them from Event Script flows and MiniGraph knowledge graphs
 * through the declarative yaml.event.over.http routing map. Orchestration
 * stays in the engines; this package deliberately provides functions only,
 * plus the minimalist utilities (configuration, logging, telemetry) shared
 * with the engine style.
 */
export { PostOffice } from './client.js';
export type { CallOptions } from './client.js';
export { AppConfig, appConfig, loadConfig } from './config.js';
export { EventEnvelope, isoUtc } from './envelope.js';
export { AppException, CompactFormatError } from './exceptions.js';
export { getLogger, Logger } from './log.js';
export { defaultRegistry, FunctionRegistry, preload, validateRoute } from './registry.js';
export type { Handler, ServiceDef } from './registry.js';
export { EventApiServer, Platform, platform } from './server.js';
export { annotateTrace, getTrace } from './trace.js';
export type { TraceInfo } from './trace.js';

export const VERSION = '0.1.0';

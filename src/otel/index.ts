/**
 * The OpenTelemetry trace forwarder - the engines' `opentelemetry-forwarder`
 * extension for this host, opt-in and dependency-free.
 *
 * Every traced, non-RPC execution already emits the engines' distributed-trace
 * dataset on the `distributed.tracing` log stream. With `otel.forwarding=true` the
 * host ALSO hands each dataset to a function on the engines' extension route
 * `distributed.trace.forwarder`; the built-in forwarder registered there maps the
 * dataset to one OpenTelemetry span carrying the host's exact W3C ids and exports
 * it over OTLP/HTTP (protobuf) to the configured endpoint - Dynatrace, Splunk, an
 * OpenTelemetry Collector - so one trace spans the engines and the polyglot
 * functions they call. Off by default: the switch is the only thing that turns it on.
 */
import type { AppConfig } from '../config.js';
import { getLogger } from '../log.js';
import type { FunctionRegistry } from '../registry.js';
import { DISTRIBUTED_TRACE_FORWARDER } from '../trace.js';
import { FORWARDING_SWITCH, HEADERS, settingsFromConfig } from './config.js';
import { Exporter, ExportFailure } from './export.js';
import { hex, spanFromDataset } from './span.js';

export { DISTRIBUTED_TRACE_FORWARDER } from '../trace.js';
export { FORWARDING_SWITCH, fixedSettings, parseHeaders, settingsFromConfig } from './config.js';
export type { ForwarderSettings, HeaderSupplier } from './config.js';
export { describeHttpFailure, Exporter, ExportFailure, INSTRUMENTATION_SCOPE } from './export.js';
export { attribute, parseIso8601Nanos, spanFromDataset } from './span.js';
export type { AttributeValue, Span } from './span.js';
export { encodeExportRequest, partialSuccess, ProtoReader, ProtoWriter,
         SPAN_FLAGS_SAMPLED_LOCAL } from './otlp.js';

const log = getLogger('mercury.otel');

/** The engines run the forwarder with two workers. */
export const FORWARDER_INSTANCES = 2;

/**
 * The `distributed.trace.forwarder` function bound to one exporter: map the
 * dataset to a span and export it, logging - never throwing - a failure.
 */
export function forwarder(exporter: Exporter): (headers: Record<string, string>, body: unknown) => Promise<void> {
  return async (_headers, body) => {
    // a dataset without W3C-valid ids cannot become a span without forging ids - skipped
    const span = spanFromDataset(body);
    if (!span) return;
    try {
      await exporter.export(span);
    } catch (e) {
      const failure = e as ExportFailure;
      log.warn(`OTLP export failed for span ${hex(span.spanId)} of trace ${hex(span.traceId)} - ` +
        failure.message);
    }
  };
}

/** Whether `otel.forwarding` is switched on (the text `true`, case-insensitive). */
export function enabled(config: AppConfig): boolean {
  const value = config.getProperty(FORWARDING_SWITCH);
  return value !== undefined && value.trim().toLowerCase() === 'true';
}

/**
 * Register the built-in forwarder on `distributed.trace.forwarder` when
 * `otel.forwarding=true` - the host's start-up hook. Returns the exporter, or
 * undefined when forwarding is off or a function already occupies the route (an
 * application's own forwarder wins, as in the engines). A misconfigured endpoint
 * fails the start.
 */
export function activate(config: AppConfig, registry: FunctionRegistry): Exporter | undefined {
  if (!enabled(config)) return undefined;
  if (registry.exists(DISTRIBUTED_TRACE_FORWARDER)) {
    log.info(`${DISTRIBUTED_TRACE_FORWARDER} is provided by the application - the built-in ` +
      'OpenTelemetry forwarder stands down');
    return undefined;
  }
  const exporter = new Exporter(settingsFromConfig(config));
  const names = exporter.headerNames();
  log.info(`OpenTelemetry trace forwarder ready - service=${exporter.serviceName}, OTLP ` +
    `endpoint=${exporter.endpoint}, compression=${exporter.compression}, credential ` +
    `headers=${JSON.stringify(names)}`);
  if (!names.length) {
    log.info(`No OTLP credential header yet (${HEADERS} unset) - it is re-read on every export, ` +
      'so a credential published later takes effect without a restart');
  }
  registry.register(DISTRIBUTED_TRACE_FORWARDER, forwarder(exporter),
                    { instances: FORWARDER_INSTANCES, isPrivate: true });
  return exporter;
}

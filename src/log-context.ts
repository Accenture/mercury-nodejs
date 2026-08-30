/**
 * Application log context - the engines' app-log-context feature.
 *
 * When enabled (`app.log.context`, default true), the structured log
 * presentations (log.format json/compact) add a `context` block to every log
 * line written inside a traced request, so application logs and the
 * distributed-trace telemetry stream correlate end to end in one aggregation.
 *
 * The context template mirrors the engines' contract exactly:
 * - The built-in default template carries the standard trace context
 *   (cid, traceId, tracePath, spanId, parentSpanId, service, timestamp).
 * - An application may replace it entirely with its own app-log-context.yaml
 *   in the resources folder (next to application.yml), mapping each output
 *   key to a reserved `$token` - resolved live per log line - or a constant
 *   (a literal, or `${ENV:default}` resolved once at load).
 * - `app.log.context=false` opts out.
 * - The `cid` token is the BUSINESS correlation-id only (the engine-managed
 *   my_cid tag); an internal routing id under the `cid` label would mislead
 *   log aggregation.
 * - Developer-supplied key-values (updateContext) merge into the block; keys
 *   resolving to null are omitted, never "null".
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { appConfig } from './config.js';
import { isoUtc } from './envelope.js';
import { getLogger } from './log.js';
import { RESERVED_CONTEXT_TOKENS, TraceInfo } from './trace.js';

const FEATURE_FLAG = 'app.log.context';
const CONFIG_FILE = 'app-log-context.yaml';
// the built-in default template ships as a packaged resource next to this
// module, exactly like the engines' classpath:/default-log-context.yaml
const DEFAULT_FILE = 'default-log-context.yaml';

/** The template's `context:` section, or undefined when absent/malformed. */
function contextSection(data: unknown): Record<string, unknown> | undefined {
  const section = data && typeof data === 'object'
    ? (data as Record<string, unknown>).context : undefined;
  if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return undefined;
}

/** The built-in default template from the packaged default-log-context.yaml. */
function defaultTemplate(): Record<string, unknown> | undefined {
  const candidate = join(dirname(fileURLToPath(import.meta.url)), DEFAULT_FILE);
  if (!existsSync(candidate)) {
    return undefined;
  }
  return contextSection(parse(readFileSync(candidate, 'utf-8')) ?? {});
}

/** Resolve a reserved token to its live value (undefined when absent). */
function tokenValue(info: TraceInfo, token: string): unknown {
  switch (token) {
    case 'cid': return info.myCorrelationId;
    case 'traceId': return info.traceId;
    case 'tracePath': return info.tracePath;
    case 'spanId': return info.spanId;
    case 'parentSpanId': return info.parentSpanId;
    case 'service': return info.route;
    case 'utc': return isoUtc();
    default: return undefined;
  }
}

/** Parsed context template: output key -> reserved token or constant. */
export class LogContextConfig {
  readonly enabled: boolean;
  private readonly tokens: Record<string, string> = {};
  private readonly constants: Record<string, unknown> = {};

  constructor(template: Record<string, unknown> | undefined) {
    for (const [outputKey, raw] of Object.entries(template ?? {})) {
      this.parseEntry(outputKey, typeof raw === 'string' ? raw : String(raw));
    }
    this.enabled = Object.keys(this.tokens).length > 0
      || Object.keys(this.constants).length > 0;
  }

  /**
   * One template entry: a reserved $token, or a constant (env-resolved value
   * or literal; an unset ${VAR} with no default resolves to undefined and is
   * dropped) - the engines' parseEntry.
   */
  private parseEntry(outputKey: string, value: string): void {
    if (value.startsWith('$') && !value.startsWith('${')) {
      const token = value.slice(1);
      if (!RESERVED_CONTEXT_TOKENS.has(token)) {
        throw new Error(`Invalid log context token '${value}' for key ` +
          `'${outputKey}' - allowed tokens: ` +
          [...RESERVED_CONTEXT_TOKENS].sort((a, b) => a.localeCompare(b)).join(', '));
      }
      this.tokens[outputKey] = token;
      return;
    }
    const resolved = appConfig().resolveText(value);
    if (resolved !== undefined && resolved !== null) {
      this.constants[outputKey] = resolved;
    }
  }

  /**
   * The context block for one log line: template tokens resolved live,
   * constants, and the developer's custom key-values. Keys resolving to
   * null/undefined are omitted.
   */
  render(info: TraceInfo): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [outputKey, token] of Object.entries(this.tokens)) {
      const value = tokenValue(info, token);
      if (value !== undefined && value !== null) {
        out[outputKey] = value;
      }
    }
    Object.assign(out, this.constants);
    for (const [key, value] of Object.entries(info.customContext ?? {})) {
      if (value !== undefined && value !== null) {
        out[key] = value;
      }
    }
    return out;
  }
}

/**
 * Resolve the active template; never logs itself - the caller emits the
 * warning AFTER installing the config, so the log line (which renders through
 * this feature) cannot re-enter.
 */
function load(): { config: LogContextConfig; warning?: string } {
  const config = appConfig();
  if ((config.getProperty(FEATURE_FLAG, 'true') ?? 'true').toLowerCase() === 'false') {
    return { config: new LogContextConfig(undefined) };
  }
  // an application override replaces the default entirely - same resources
  // convention as application.yml
  const source = config.source;
  const folder = source !== 'none' ? dirname(source) : 'resources';
  const candidate = join(folder || 'resources', CONFIG_FILE);
  if (existsSync(candidate)) {
    const section = contextSection(parse(readFileSync(candidate, 'utf-8')) ?? {});
    if (!section) {
      // the engines log a warning and disable; mirror the outcome
      return {
        config: new LogContextConfig(undefined),
        warning: `Log context config has no 'context' section - feature disabled (${candidate})`
      };
    }
    return { config: new LogContextConfig(section) };
  }
  const template = defaultTemplate();
  if (!template) {
    return {
      config: new LogContextConfig(undefined),
      warning: `Built-in ${DEFAULT_FILE} missing - log context feature disabled`
    };
  }
  return { config: new LogContextConfig(template) };
}

let instance: LogContextConfig | undefined;

/** The shared context template (loaded on first structured log line). */
export function logContextConfig(): LogContextConfig {
  if (!instance) {
    const { config, warning } = load();
    instance = config;
    if (warning) {
      // safe: the instance is installed first, so this line cannot re-enter
      getLogger('mercury.log').warn(warning);
    }
  }
  return instance;
}

/** Test seam: reset so the next structured log line reloads the template. */
export function resetLogContextForTest(): void {
  instance = undefined;
}

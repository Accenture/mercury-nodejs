/**
 * Minimalist logging, presentation-consistent with the Mercury engines.
 *
 * Text lines follow the Java reference engine's log4j2 pattern:
 *
 *   %d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger:%line - %msg
 *
 * Level comes from the LOG_LEVEL environment variable when set (mirroring the
 * engines), else the log.level configuration key, else INFO. log.format
 * carries the engines' three presentations: text (default), json
 * (pretty-printed) and compact (the same object on a single line - JSONL -
 * for log aggregators). Inside a traced request, the JSON presentations add
 * the application log "context" block (the engines' app-log-context feature -
 * see log-context.ts).
 */
import { appConfig } from './config.js';
import { logContextConfig } from './log-context.js';
import { getTrace } from './trace.js';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type Level = (typeof LEVELS)[number];

let configured = false;
let minLevel = 1; // INFO
let logFormat = 'text';

function setup(): void {
  if (configured) return;
  const config = appConfig();
  const levelName = (process.env.LOG_LEVEL ?? String(config.get('log.level', 'INFO'))).toUpperCase();
  const idx = LEVELS.indexOf(levelName as Level);
  minLevel = idx === -1 ? 1 : idx;
  logFormat = String(config.get('log.format', 'text')).toLowerCase();
  configured = true;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function callSite(): string {
  // frame 0 = Error, 1 = callSite, 2 = Logger method, 3 = the caller
  const stack = new Error('log call site').stack?.split('\n') ?? [];
  const frame = stack[4] ?? stack[3] ?? '';
  // right-to-left parse of ".../name.js:LINE:COL[)]" - linear, no regex scanning
  const end = frame.endsWith(')') ? frame.length - 1 : frame.length;
  const colCut = frame.lastIndexOf(':', end - 1);
  const lineCut = colCut > 0 ? frame.lastIndexOf(':', colCut - 1) : -1;
  if (lineCut <= 0) return 'unknown:0';
  const line = frame.slice(lineCut + 1, colCut);
  if (!/^\d+$/.test(line)) return 'unknown:0';
  const start = Math.max(frame.lastIndexOf('/', lineCut), frame.lastIndexOf('\\', lineCut),
                         frame.lastIndexOf('(', lineCut), frame.lastIndexOf(' ', lineCut)) + 1;
  const name = frame.slice(start, lineCut).replace(/\.[cm]?js$/, '');
  return `${name}:${line}`;
}

type LogMessage = string | Record<string, unknown>;

function renderMessage(message: LogMessage, args: unknown[]): LogMessage {
  // a structured (object) message stays structural in the JSON presentations
  // and renders as compact JSON in text mode - used by the distributed-trace
  // dataset records, which stdout log-ingest agents parse
  if (typeof message === 'object' && message !== null && !args.length) {
    return message;
  }
  const head = typeof message === 'string' ? message : JSON.stringify(message);
  return args.length
    ? `${head} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
    : head;
}

function write(level: Level, name: string | undefined, message: LogMessage, args: unknown[]): void {
  setup();
  if (LEVELS.indexOf(level) < minLevel) return;
  const rendered = renderMessage(message, args);
  const logger = name ?? callSite();
  if (logFormat === 'json' || logFormat === 'compact') {
    const entry: Record<string, unknown> = {
      time: timestamp(),
      level,
      logger,
      message: rendered
    };
    // the application log context (the engines' app-log-context feature):
    // a "context" block on every structured line inside a traced request,
    // correlating app logs with the distributed-trace telemetry stream
    const info = getTrace();
    if (info?.traceId) {
      const contextConfig = logContextConfig();
      if (contextConfig.enabled) {
        entry.context = contextConfig.render(info);
      }
    }
    // engine presentations: json = pretty-printed, compact = one line (JSONL)
    const indent = logFormat === 'json' ? 2 : undefined;
    process.stdout.write(JSON.stringify(entry, null, indent) + '\n');
  } else {
    const text = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
    process.stdout.write(`${timestamp()} ${level.padEnd(5)} ${logger} - ${text}\n`);
  }
}

export class Logger {
  constructor(private readonly name?: string) {}
  debug(message: LogMessage, ...args: unknown[]): void { write('DEBUG', this.name, message, args); }
  info(message: LogMessage, ...args: unknown[]): void { write('INFO', this.name, message, args); }
  warn(message: LogMessage, ...args: unknown[]): void { write('WARN', this.name, message, args); }
  error(message: LogMessage, ...args: unknown[]): void { write('ERROR', this.name, message, args); }
}

/** A logger writing engine-consistent log lines. */
export function getLogger(name?: string): Logger {
  return new Logger(name);
}

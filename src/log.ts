/**
 * Minimalist logging, presentation-consistent with the Mercury engines.
 *
 * Text lines follow the Java reference engine's log4j2 pattern:
 *
 *   %d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger:%line - %msg
 *
 * Level comes from the LOG_LEVEL environment variable when set (mirroring the
 * engines), else the log.level configuration key, else INFO. log.format=json
 * switches to one JSON object per line with the same information plus
 * trace_id when a trace context is active.
 */
import { appConfig } from './config.js';
import { getTrace } from './trace.js';

const LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type Level = (typeof LEVELS)[number];

let configured = false;
let minLevel = 1; // INFO
let jsonFormat = false;

function setup(): void {
  if (configured) return;
  const config = appConfig();
  const levelName = (process.env.LOG_LEVEL ?? String(config.get('log.level', 'INFO'))).toUpperCase();
  const idx = LEVELS.indexOf(levelName as Level);
  minLevel = idx === -1 ? 1 : idx;
  jsonFormat = String(config.get('log.format', 'text')).toLowerCase() === 'json';
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
  const stack = new Error().stack?.split('\n') ?? [];
  const frame = stack[4] ?? stack[3] ?? '';
  const match = frame.match(/([^/\\(\s]+?):(\d+):\d+\)?$/);
  return match ? `${match[1].replace(/\.[cm]?js$/, '')}:${match[2]}` : 'unknown:0';
}

function write(level: Level, name: string | undefined, message: string, args: unknown[]): void {
  setup();
  if (LEVELS.indexOf(level) < minLevel) return;
  const rendered = args.length
    ? `${message} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
    : message;
  const logger = name ?? callSite();
  if (jsonFormat) {
    const entry: Record<string, unknown> = {
      time: timestamp(),
      level,
      logger,
      message: rendered
    };
    const info = getTrace();
    if (info?.traceId) entry.trace_id = info.traceId;
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    process.stdout.write(`${timestamp()} ${level.padEnd(5)} ${logger} - ${rendered}\n`);
  }
}

export class Logger {
  constructor(private readonly name?: string) {}
  debug(message: string, ...args: unknown[]): void { write('DEBUG', this.name, message, args); }
  info(message: string, ...args: unknown[]): void { write('INFO', this.name, message, args); }
  warn(message: string, ...args: unknown[]): void { write('WARN', this.name, message, args); }
  error(message: string, ...args: unknown[]): void { write('ERROR', this.name, message, args); }
}

/** A logger writing engine-consistent log lines. */
export function getLogger(name?: string): Logger {
  return new Logger(name);
}

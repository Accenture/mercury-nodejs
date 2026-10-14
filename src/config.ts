/**
 * Minimalist configuration management, consistent with the Mercury engines.
 *
 * Same conventions as the Java/Rust AppConfigReader: configuration lives in
 * the resources folder NEXT TO THE APPLICATION FILE (resources/application.yml
 * | .yaml | .properties beside the file mercury-serve is given, or beside the
 * script Node ran), mirroring the engines' classpath resources - the working
 * directory is never searched, so the configuration an application starts
 * with does not depend on where it is launched from; `--config` names another
 * file. Keys are dotted; `-Dkey=value` command-line arguments are runtime parameter
 * overrides checked first on every read — the same syntax as the Java
 * engine's JVM system properties and the Rust port's -D arguments (the
 * f:setConfig analog); `${ENV_VAR:default}` substitution resolves the
 * environment first, then a base configuration key, then the default.
 *
 * Well-known keys shared with the engines: application.name,
 * rest.server.port (default 8085), log.format (text | json pretty-printed |
 * compact single-line JSONL), log.level (LOG_LEVEL environment variable
 * wins).
 */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { asText } from './envelope.js';

const REF = /\$\{([^}]+)\}/g;

const WHOLE_REF = /^\$\{([^}]+)\}$/;

export const DEFAULT_CANDIDATES = [
  'resources/application.yml',
  'resources/application.yaml',
  'resources/application.properties'
];

export const RESOURCES_FOLDER = 'resources';

/**
 * The folder of the script Node ran (`node app.mjs`) - where a direct run finds
 * its resources folder; undefined when there is no script (`node -e`, a REPL).
 */
export function mainScriptDir(): string | undefined {
  const script = process.argv[1];
  return script ? dirname(resolve(script)) : undefined;
}

function isFile(candidate: string): boolean {
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
}

/** Extract -Dkey=value runtime overrides (Java/Rust engine syntax). */
export function parseDArgs(argv: string[]): Map<string, unknown> {
  const overrides = new Map<string, unknown>();
  for (const arg of argv) {
    if (arg.startsWith('-D') && arg.includes('=')) {
      const idx = arg.indexOf('=');
      const key = arg.slice(2, idx).trim();
      if (key) overrides.set(key, arg.slice(idx + 1));
    }
  }
  return overrides;
}

function flatten(prefix: string, node: unknown, out: Map<string, unknown>): void {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${k}` : k, v, out);
    }
  } else {
    out.set(prefix, node);
  }
}

function parseProperties(text: string): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    result.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return result;
}

export class AppConfig {
  private store = new Map<string, unknown>();
  private readonly overrides: Map<string, unknown>;
  /**
   * The configuration file loaded (an explicit path as given, else the absolute
   * path of the file found next to the application file), or 'none'.
   */
  readonly source: string;
  /**
   * The resources folder companion files (app-log-context.yaml) share with the
   * configuration file - beside an explicit file, else next to the application
   * file; undefined when there is neither.
   */
  readonly resourcesDir?: string;

  /**
   * `path` names the configuration file explicitly; otherwise the file is one of
   * DEFAULT_CANDIDATES under `appDir` - the application file's folder, defaulting
   * to the folder of the script Node ran. The working directory is never searched.
   */
  constructor(path?: string, argv?: string[], appDir?: string) {
    this.overrides = parseDArgs(argv ?? process.argv.slice(2));
    let loaded = 'none';
    if (path) {
      if (!isFile(path)) {
        throw new Error(`Configuration file not found - ${path}`);
      }
      this.load(path);
      loaded = path;
      this.resourcesDir = dirname(resolve(path));
    } else {
      const folder = appDir ?? mainScriptDir();
      if (folder) {
        this.resourcesDir = join(folder, RESOURCES_FOLDER);
        for (const candidate of DEFAULT_CANDIDATES) {
          const probe = join(folder, candidate);
          if (isFile(probe)) {
            this.load(probe);
            loaded = probe;
            break;
          }
        }
      }
    }
    this.source = loaded;
  }

  private load(path: string): void {
    const text = fs.readFileSync(path, 'utf-8');
    if (path.endsWith('.yml') || path.endsWith('.yaml')) {
      const data = YAML.parse(text) ?? {};
      const flat = new Map<string, unknown>();
      flatten('', data, flat);
      this.store = flat;
    } else {
      this.store = parseProperties(text);
    }
  }

  /** Runtime override, checked first on every read (f:setConfig analog). */
  set(key: string, value: unknown): void {
    if (!key?.trim()) {
      throw new Error('Config key must not be empty');
    }
    this.overrides.set(key, value);
  }

  get(key: string, defaultValue: unknown = undefined): unknown {
    if (this.overrides.has(key)) return this.overrides.get(key);
    if (this.store.has(key)) {
      const value = this.store.get(key);
      return typeof value === 'string' ? this.substitute(value, defaultValue) : value;
    }
    return defaultValue;
  }

  getProperty(key: string, defaultValue?: string): string | undefined {
    const value = this.get(key, defaultValue);
    return value === undefined || value === null ? undefined : asText(value);
  }

  /**
   * Resolve ${ENV:default} substitution in a text value - the same rules as
   * configuration values (used by companion config files such as
   * app-log-context.yaml).
   */
  resolveText(value: string): unknown {
    return this.substitute(value, undefined);
  }

  exists(key: string): boolean {
    return this.overrides.has(key) || this.store.has(key);
  }

  private substitute(value: string, defaultValue: unknown): unknown {
    const whole = WHOLE_REF.exec(value.trim());
    if (whole) {
      const resolved = this.resolveRef(whole[1]);
      return resolved === undefined ? defaultValue : resolved;
    }
    return value.replace(REF, (_m, ref: string) => {
      const resolved = this.resolveRef(ref);
      return resolved === undefined || resolved === null ? '' : asText(resolved);
    });
  }

  private resolveRef(ref: string): unknown {
    const idx = ref.indexOf(':');
    const name = (idx === -1 ? ref : ref.slice(0, idx)).trim();
    const fallback = idx === -1 ? undefined : ref.slice(idx + 1);
    if (name in process.env) return process.env[name];
    if (this.store.has(name)) {
      const base = this.store.get(name);
      if (typeof base === 'string' && /\$\{[^}]+\}/.test(base)) {
        return this.substitute(base, undefined);
      }
      return base;
    }
    return fallback;
  }
}

let instance: AppConfig | undefined;

/**
 * The shared AppConfig singleton (created on first use - a direct `node app.mjs`
 * run resolves its resources folder next to the script).
 */
export function appConfig(): AppConfig {
  instance ??= new AppConfig();
  return instance;
}

/**
 * Replace the shared AppConfig (used by the CLI before startup, with the
 * application file's folder as `appDir`).
 */
export function loadConfig(path?: string, appDir?: string): AppConfig {
  instance = new AppConfig(path, undefined, appDir);
  return instance;
}

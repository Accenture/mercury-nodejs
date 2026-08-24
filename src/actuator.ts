/**
 * Actuator endpoints for operations and Kubernetes deployment.
 *
 * The same operational surface as the engines (the Java ActuatorServices and
 * its Rust port), so a polyglot installation monitors every app one way:
 *
 * - GET /info - application identity (name, version, description), runtime,
 *   origin id, start/current time and uptime.
 * - GET /info/routes - the local routing table split by visibility
 *   (routing.public / routing.private, route -> instance count).
 * - GET /env - selected environment variables (show.env.variables) and
 *   selected configuration parameters (show.application.properties) -
 *   opt-in lists, so secrets are never dumped wholesale (engine parity).
 * - GET /health - runs the health check functions listed in
 *   mandatory.health.dependencies / optional.health.dependencies. All
 *   mandatory up -> UP (HTTP 200); any mandatory down -> DOWN (HTTP 400,
 *   engine parity). The outcome feeds the liveness state.
 * - GET /livenessprobe - "OK" (text) while the last health outcome is good,
 *   else HTTP 400 "Unhealthy. Please check '/health' endpoint."
 *
 * A health check function is a normal registered function (usually private)
 * speaking the engines' interface contract - called through the same event
 * bus that serves PostOffice, first with header type=info (an advisory
 * identity map merged into its dependency entry), then with type=health (a
 * status text or map; a non-200 reply marks the dependency down):
 *
 *   preload('demo.health', { isPrivate: true }, async (headers, _body) => {
 *     if (headers.type === 'info') {
 *       return { service: 'demo.service', href: 'http://127.0.0.1' };
 *     }
 *     return 'demo.service is running fine';
 *   });
 *
 * Engine deltas (deliberate, wrapper-scale): no /info/lib (a wrapper app has
 * no runtime dependency manifest - deferred on the Rust port too), no XML
 * responses, and no 5-second info cache (dependencies are in-process
 * functions, so the type=info lookup costs nothing).
 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { DeliveryTimeout } from './bus.js';
import { appConfig } from './config.js';
import { asText, isoUtc } from './envelope.js';
import { getLogger } from './log.js';
import { FunctionRegistry } from './registry.js';
import { VERSION } from './version.js';

const log = getLogger('mercury.actuator');

const INFO_TIMEOUT_MS = 3000; // engine value for the advisory type=info lookup
const HEALTH_TIMEOUT_MS = 10000; // engine value for the type=health probe
const UNHEALTHY = "Unhealthy. Please check '/health' endpoint.";

let origin: string | undefined;

/**
 * Unique instance id, minted once per process (the Java reference engine's
 * format: UTC yyyyMMdd date prefix + 32-hex uuid).
 */
export function appOrigin(): string {
  if (!origin) {
    const date = isoUtc(new Date()).slice(0, 10).replaceAll('-', '');
    origin = date + randomUUID().replaceAll('-', '');
  }
  return origin;
}

/**
 * Human-readable duration matching the engines' rendering (including their
 * strict boundary behavior, kept verbatim for parity).
 */
export function elapsedTime(milliseconds: number): string {
  const ONE_SECOND = 1000;
  const ONE_MINUTE = 60 * ONE_SECOND;
  const ONE_HOUR = 60 * ONE_MINUTE;
  const ONE_DAY = 24 * ONE_HOUR;
  let remaining = Math.trunc(milliseconds);
  const parts: string[] = [];
  if (remaining > ONE_DAY) {
    const days = Math.trunc(remaining / ONE_DAY);
    parts.push(`${days} day${days === 1 ? '' : 's'}`);
    remaining -= days * ONE_DAY;
  }
  if (remaining > ONE_HOUR) {
    const hours = Math.trunc(remaining / ONE_HOUR);
    parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    remaining -= hours * ONE_HOUR;
  }
  if (remaining > ONE_MINUTE) {
    const minutes = Math.trunc(remaining / ONE_MINUTE);
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    remaining -= minutes * ONE_MINUTE;
  }
  if (remaining >= ONE_SECOND) {
    const seconds = Math.trunc(remaining / ONE_SECOND);
    parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  }
  return parts.length ? parts.join(' ') : `${remaining} ms`;
}

/** A comma/space-separated string (engine syntax) or a YAML list. */
function asList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => asText(item).trim())
    : asText(value ?? '').split(/[,\s]+/);
  return items.filter((item) => item.length > 0);
}

function isMessageShape(body: unknown): boolean {
  // the engines accept only text or map dependency messages
  return typeof body === 'string' ||
    (body !== null && typeof body === 'object' && !Array.isArray(body));
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

/** HTTP handlers for the actuator endpoints (wired by EventApiServer). */
export class Actuator {
  private readonly registry: FunctionRegistry;
  private readonly start = new Date();
  private healthy = true; // liveness follows the most recent /health outcome
  private readonly appName: string;
  private readonly appVersion: string;
  private readonly description: string;
  private readonly required: string[];
  private readonly optional: string[];

  constructor(registry: FunctionRegistry) {
    const config = appConfig();
    this.registry = registry;
    this.appName = config.getProperty('application.name', 'application') || 'application';
    this.appVersion = config.getProperty('info.app.version', VERSION) || VERSION;
    this.description = config.getProperty('info.app.description', this.appName) || this.appName;
    this.required = asList(config.get('mandatory.health.dependencies'));
    this.optional = asList(config.get('optional.health.dependencies'));
    if (this.required.length) {
      log.info(`Mandatory service dependencies - ${JSON.stringify(this.required)}`);
    }
    if (this.optional.length) {
      log.info(`Optional services dependencies - ${JSON.stringify(this.optional)}`);
    }
  }

  /** Route a GET to its actuator endpoint; false when the path is not ours. */
  async handle(pathname: string, res: http.ServerResponse): Promise<boolean> {
    switch (pathname) {
      case '/info':
        sendJson(res, 200, this.info());
        return true;
      case '/info/routes':
        sendJson(res, 200, this.routes());
        return true;
      case '/env':
        sendJson(res, 200, this.env());
        return true;
      case '/health': {
        const [status, body] = await this.health();
        sendJson(res, status, body);
        return true;
      }
      case '/livenessprobe':
        if (this.healthy) {
          sendText(res, 200, 'OK');
        } else {
          sendText(res, 400, UNHEALTHY);
        }
        return true;
      default:
        return false;
    }
  }

  private appBlock(): Record<string, unknown> {
    return { name: this.appName, version: this.appVersion, description: this.description };
  }

  private info(): Record<string, unknown> {
    const now = new Date();
    return {
      app: this.appBlock(),
      runtime: { language: 'node.js', node: process.version, mercury_composable: VERSION },
      origin: appOrigin(),
      time: { start: isoUtc(this.start), current: isoUtc(now) },
      up_time: elapsedTime(now.getTime() - this.start.getTime())
    };
  }

  private routes(): Record<string, unknown> {
    const publicRoutes: Record<string, number> = {};
    const privateRoutes: Record<string, number> = {};
    for (const service of this.registry.routes()) { // already route-sorted
      (service.isPrivate ? privateRoutes : publicRoutes)[service.route] = service.instances;
    }
    return { app: this.appBlock(), routing: { public: publicRoutes, private: privateRoutes } };
  }

  private env(): Record<string, unknown> {
    const config = appConfig();
    const environment: Record<string, string> = {};
    for (const name of asList(config.get('show.env.variables'))) {
      environment[name] = process.env[name] ?? '';
    }
    const properties: Record<string, string> = {};
    for (const name of asList(config.get('show.application.properties'))) {
      properties[name] = config.getProperty(name) ?? '';
    }
    return { app: this.appBlock(), env: { environment, properties } };
  }

  private async health(): Promise<[number, Record<string, unknown>]> {
    const dependency: Record<string, unknown>[] = [];
    // optional services never affect the overall status (engine semantics)
    await this.checkServices(this.optional, false, dependency);
    const up = await this.checkServices(this.required, true, dependency);
    this.healthy = up;
    const result: Record<string, unknown> = {};
    if (!dependency.length) {
      result.message = 'Did you forget to define mandatory.health.dependencies ' +
        'or optional.health.dependencies';
    }
    result.dependency = dependency;
    result.status = up ? 'UP' : 'DOWN';
    result.origin = appOrigin();
    result.name = this.appName;
    return [up ? 200 : 400, result];
  }

  private async checkServices(services: string[], required: boolean,
                              dependency: Record<string, unknown>[]): Promise<boolean> {
    let allUp = true;
    for (const route of services) {
      const entry: Record<string, unknown> = { route, required };
      dependency.push(entry);
      if (!await this.checkService(route, entry)) {
        allUp = false;
      }
    }
    return allUp;
  }

  /** Probe one health-check function; false when it is missing or down. */
  private async checkService(route: string, entry: Record<string, unknown>): Promise<boolean> {
    const service = this.registry.get(route);
    if (!service) {
      entry.status_code = 404;
      entry.message = `Please check - Route ${route} not found`;
      return false;
    }
    const bus = this.registry.bus;
    // info is advisory - merge whatever the service reports about itself;
    // the health probe below decides the status
    try {
      const info = await bus.deliver(service, { type: 'info' }, null, INFO_TIMEOUT_MS);
      if (info.body !== null && typeof info.body === 'object' && !Array.isArray(info.body)) {
        Object.assign(entry, info.body);
      }
    } catch (e) {
      if (!(e instanceof DeliveryTimeout)) throw e;
    }
    try {
      const reply = await bus.deliver(service, { type: 'health' }, null, HEALTH_TIMEOUT_MS);
      entry.status_code = reply.getStatus();
      if (isMessageShape(reply.body)) {
        entry.message = reply.body;
      }
      return !reply.hasError();
    } catch (e) {
      if (!(e instanceof DeliveryTimeout)) throw e;
      entry.status_code = 408;
      entry.message = `Please check - ${e.message}`;
      return false;
    }
  }
}

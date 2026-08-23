/**
 * The Event API host: POST /api/event, exactly as the engines speak it.
 *
 * Mirrors the Java engine's EventApiService: request body = envelope bytes;
 * x-ttl (ms, floor 1000) bounds handler execution; x-async: true means
 * drop-n-forget (HTTP 202 with an ack envelope). Transport-level failures
 * (400 / 403 / 404 / 408) set the HTTP status; a handler's own outcome —
 * including AppException and unexpected errors — rides HTTP 200 with the
 * status inside the envelope, exactly like an engine function's reply.
 * Reserved header hygiene: x-event-api and transported my_* keys are removed
 * from the handler's header view; the my_cid tag is injected as the
 * read-only my_correlation_id header.
 * The host also serves the engines' actuator endpoints (/info, /info/routes,
 * /env, /health, /livenessprobe) for operations and Kubernetes probes - see
 * actuator.ts.
 */
import * as http from 'node:http';
import { Actuator } from './actuator.js';
import { DeliveryTimeout } from './bus.js';
import { appConfig } from './config.js';
import { EventEnvelope } from './envelope.js';
import { CompactFormatError } from './exceptions.js';
import { getLogger } from './log.js';
import { defaultRegistry, FunctionRegistry } from './registry.js';

const OCTET_STREAM = 'application/octet-stream';
const log = getLogger('mercury.server');

function transportError(res: http.ServerResponse, status: number, message: string): void {
  const reply = new EventEnvelope().setStatus(status).setBody(message);
  const bytes = reply.toBytes();
  res.writeHead(status, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
  res.end(bytes);
}

function handlerHeaders(event: EventEnvelope): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers)) {
    const key = k.toLowerCase();
    if (key !== 'x-event-api' && !key.startsWith('my_')) {
      headers[k] = v;
    }
  }
  const myCid = event.tags['my_cid'];
  if (myCid) {
    headers['my_correlation_id'] = myCid;
  }
  return headers;
}

export class EventApiServer {
  private readonly actuator: Actuator;

  /** Thin ingress: protocol guards + header hygiene, then the registry's bus. */
  constructor(readonly registry: FunctionRegistry = defaultRegistry) {
    this.actuator = new Actuator(registry);
  }

  private async handleEvent(req: http.IncomingMessage, res: http.ServerResponse,
                            raw: Buffer): Promise<void> {
    const ttl = Math.max(1000, parseInt(String(req.headers['x-ttl'] ?? '0'), 10) || 0);
    const isAsync = req.headers['x-async'] === 'true';
    let event: EventEnvelope;
    try {
      event = EventEnvelope.fromBytes(raw);
    } catch (e) {
      if (e instanceof CompactFormatError || e instanceof Error) {
        transportError(res, 400, e.message);
        return;
      }
      transportError(res, 400, String(e));
      return;
    }
    if (!event.to) {
      transportError(res, 400, 'Missing routing path');
      return;
    }
    const service = this.registry.get(event.to);
    if (!service) {
      transportError(res, 404, `Route ${event.to} not found`);
      return;
    }
    if (service.isPrivate) {
      transportError(res, 403, `${event.to} is private`);
      return;
    }
    const headers = handlerHeaders(event);
    const bus = this.registry.bus;
    const trace = { traceId: event.traceId, tracePath: event.tracePath, cid: event.cid };
    if (isAsync) {
      const ack = bus.publish(service, headers, event.body, trace);
      const bytes = ack.toBytes();
      res.writeHead(202, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    try {
      const reply = await bus.deliver(service, headers, event.body, ttl, trace);
      log.info(`Handled ${event.to} status=${reply.getStatus()} ` +
        `exec_time=${reply.execTime}ms trace_id=${event.traceId ?? 'none'}`);
      const bytes = reply.toBytes();
      res.writeHead(200, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
      res.end(bytes);
    } catch (e) {
      if (e instanceof DeliveryTimeout) {
        log.warn(`Event ${event.to} timeout for ${ttl} ms (trace_id=${event.traceId ?? 'none'})`);
        transportError(res, 408, `Timeout for ${ttl} ms`);
      } else {
        transportError(res, 500, (e as Error).message ?? String(e));
      }
    }
  }

  createServer(): http.Server {
    return http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET') {
        this.actuator.handle(url.pathname, res).then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not found');
          }
        }).catch((e) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end((e as Error).message ?? String(e));
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/event') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          this.handleEvent(req, res, Buffer.concat(chunks)).catch((e) => {
            transportError(res, 500, (e as Error).message ?? String(e));
          });
        });
        req.on('error', () => res.destroy());
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    });
  }
}

export class Platform {
  constructor(readonly registry: FunctionRegistry = defaultRegistry) {}

  /** Start the Event API host. Resolves once listening; runs until stopped. */
  async run(options: { port?: number; host?: string } = {}): Promise<http.Server> {
    const config = appConfig();
    const appName = config.getProperty('application.name', 'application');
    const port = options.port ?? Number(config.get('rest.server.port', 8085));
    const host = options.host ?? '127.0.0.1';
    for (const service of this.registry.routes()) {
      const visibility = service.isPrivate ? 'PRIVATE' : 'PUBLIC';
      log.info(`Loaded ${visibility} ${service.route}, instances=${service.instances}`);
    }
    const server = new EventApiServer(this.registry).createServer();
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    log.info(`${appName} - Event API service started on port ${port}`);
    return server;
  }
}

export const platform = new Platform();

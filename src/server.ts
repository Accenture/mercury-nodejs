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
 */
import * as http from 'node:http';
import { appConfig } from './config.js';
import { EventEnvelope, isoUtc } from './envelope.js';
import { AppException, CompactFormatError } from './exceptions.js';
import { getLogger } from './log.js';
import { defaultRegistry, FunctionRegistry, ServiceDef } from './registry.js';
import { runWithTrace, TraceInfo } from './trace.js';

const OCTET_STREAM = 'application/octet-stream';
const log = getLogger('mercury.server');

class Semaphore {
  private queue: Array<() => void> = [];
  private available: number;

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

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
  private semaphores = new Map<string, Semaphore>();

  constructor(readonly registry: FunctionRegistry = defaultRegistry) {}

  private semaphore(service: ServiceDef): Semaphore {
    let semaphore = this.semaphores.get(service.route);
    if (!semaphore) {
      semaphore = new Semaphore(service.instances);
      this.semaphores.set(service.route, semaphore);
    }
    return semaphore;
  }

  /** Run the handler under its trace context and shape the outcome as a reply. */
  private async invoke(service: ServiceDef, event: EventEnvelope,
                       headers: Record<string, string>): Promise<EventEnvelope> {
    const info: TraceInfo = {
      traceId: event.traceId,
      tracePath: event.tracePath,
      cid: event.cid,
      annotations: {}
    };
    const semaphore = this.semaphore(service);
    await semaphore.acquire();
    const start = process.hrtime.bigint();
    let reply: EventEnvelope;
    try {
      const result = await runWithTrace(info, async () => service.handler(headers, event.body));
      reply = result instanceof EventEnvelope ? result : new EventEnvelope(undefined, result);
    } catch (e) {
      if (e instanceof AppException) {
        reply = new EventEnvelope().setStatus(e.status).setBody(e.message);
      } else {
        const error = e as Error;
        reply = new EventEnvelope().setStatus(500).setBody(error.message ?? String(e));
        if (error.stack) reply.stack = error.stack;
      }
    } finally {
      semaphore.release();
    }
    reply.sender = reply.sender ?? service.route;
    reply.execTime = Math.round(Number(process.hrtime.bigint() - start) / 1000) / 1000;
    if (Object.keys(info.annotations).length) {
      reply.annotations = { ...info.annotations, ...reply.annotations };
    }
    return reply;
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
    if (isAsync) {
      this.invoke(service, event, headers).then((reply) => {
        if (reply.hasError()) {
          log.warn(`Async event ${event.to} ended with status ${reply.getStatus()} - ${reply.body}`);
        }
      }).catch((e) => log.error(`Async event ${event.to} failed - ${(e as Error).message}`));
      const ack = new EventEnvelope().setStatus(202)
        .setBody({ type: 'async', delivered: true, time: isoUtc() });
      const bytes = ack.toBytes();
      res.writeHead(202, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new TimeoutSignal()), ttl);
      timer.unref();
    });
    try {
      const reply = await Promise.race([this.invoke(service, event, headers), timeout]);
      log.info(`Handled ${event.to} status=${reply.getStatus()} ` +
        `exec_time=${reply.execTime}ms trace_id=${event.traceId ?? 'none'}`);
      const bytes = reply.toBytes();
      res.writeHead(200, { 'content-type': OCTET_STREAM, 'content-length': bytes.length });
      res.end(bytes);
    } catch (e) {
      if (e instanceof TimeoutSignal) {
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
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
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

class TimeoutSignal extends Error {
  constructor() {
    super('timeout');
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

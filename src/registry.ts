/**
 * Function registry and the preload() registration, mirroring the engines'
 * PreLoad vocabulary: route name, instance count (concurrency limit) and a
 * private flag. Handlers take (headers, body) — the same two-part input as a
 * TypedLambdaFunction — and return the reply body (or an EventEnvelope for
 * full control of status and reply headers).
 */
import { EventBus } from './bus.js';
import type { EventEnvelope } from './envelope.js';

/**
 * A function handler returns the reply body, an EventEnvelope for full
 * control of status and reply headers, or a promise of either - the bus
 * awaits the result and discriminates with instanceof, so the honest
 * static type is simply unknown.
 *
 * An INTERCEPTOR handler (the engines' EventInterceptor contract) receives
 * the raw EventEnvelope as its second argument - reply_to and the
 * correlation id travel the engines' way - replies manually via reply_to,
 * and its return value is discarded. Streaming producers and relay
 * functions are interceptors. The runtime discriminates by the service's
 * interceptor flag, so one structural type covers both flavors.
 */
export type Handler = (
  headers: Record<string, string>,
  body: unknown
) => unknown;

export interface ServiceDef {
  route: string;
  handler: Handler;
  instances: number;
  isPrivate: boolean;
  interceptor: boolean;
}

const ROUTE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function validateRoute(route: string): string {
  const trimmed = (route ?? '').trim();
  if (!ROUTE_PATTERN.test(trimmed) || !trimmed.includes('.')) {
    throw new Error(
      `Invalid route name '${trimmed}' - use lowercase letters, digits, ` +
      'period, hyphen or underscore with at least one period');
  }
  return trimmed;
}

export class FunctionRegistry {
  // the registry's own dispatch pipeline (see bus.ts) - shared by the
  // HTTP host and the local side of PostOffice
  readonly bus = new EventBus();

  private readonly services = new Map<string, ServiceDef>();

  constructor() {
    // reply routing for the bus's interceptor error contract
    this.bus.bindRouter((event) => this.sendEvent(event));
  }

  register(route: string, handler: Handler,
           options: { instances?: number; isPrivate?: boolean;
                      interceptor?: boolean } = {}): ServiceDef {
    const validated = validateRoute(route);
    const service: ServiceDef = {
      route: validated,
      handler,
      instances: Math.max(1, Math.trunc(options.instances ?? 10)),
      isPrivate: options.isPrivate ?? false,
      interceptor: options.interceptor ?? false
    };
    this.services.set(validated, service);
    return service;
  }

  /**
   * The reply_to mechanism: deliver one envelope to a LOCAL reply sink or
   * registered function, drop-n-forget (simple routing, never across the
   * wire - cross-wire replies ride the Event-over-HTTP SSE response).
   * Returns false when the target no longer exists, so a late segment is a
   * no-op drop, the engines' semantics.
   */
  sendEvent(event: EventEnvelope): boolean {
    const route = event.to;
    if (!route) {
      return false;
    }
    if (this.bus.offerSink(route, event)) {
      return true;
    }
    const service = this.services.get(route);
    if (!service) {
      return false;
    }
    this.bus.publishEnvelope(service, event);
    return true;
  }

  get(route: string): ServiceDef | undefined {
    return this.services.get(route);
  }

  exists(route: string): boolean {
    return this.services.has(route);
  }

  routes(): ServiceDef[] {
    return [...this.services.values()].sort((a, b) => a.route.localeCompare(b.route));
  }
}

/** the default registry used by preload() and platform.run() */
export const defaultRegistry = new FunctionRegistry();

/**
 * Register a function handler under a route name (engine PreLoad analog).
 *
 *   preload('hello.node', { instances: 10 }, async (headers, body) => ({ ok: true }));
 */
export function preload(route: string,
                        options: { instances?: number; isPrivate?: boolean;
                                   interceptor?: boolean },
                        handler: Handler): void {
  defaultRegistry.register(route, handler, options);
}

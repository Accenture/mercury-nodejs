/**
 * Function registry and the preload() registration, mirroring the engines'
 * PreLoad vocabulary: route name, instance count (concurrency limit) and a
 * private flag. Handlers take (headers, body) — the same two-part input as a
 * TypedLambdaFunction — and return the reply body (or an EventEnvelope for
 * full control of status and reply headers).
 */
import { EventBus } from './bus.js';

/**
 * A function handler returns the reply body, an EventEnvelope for full
 * control of status and reply headers, or a promise of either - the bus
 * awaits the result and discriminates with instanceof, so the honest
 * static type is simply unknown.
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

  register(route: string, handler: Handler,
           options: { instances?: number; isPrivate?: boolean } = {}): ServiceDef {
    const validated = validateRoute(route);
    const service: ServiceDef = {
      route: validated,
      handler,
      instances: Math.max(1, Math.trunc(options.instances ?? 10)),
      isPrivate: options.isPrivate ?? false
    };
    this.services.set(validated, service);
    return service;
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
                        options: { instances?: number; isPrivate?: boolean },
                        handler: Handler): void {
  defaultRegistry.register(route, handler, options);
}

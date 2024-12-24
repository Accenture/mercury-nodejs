import { EventEnvelope } from "./event-envelope.js";
import { FunctionRegistry } from "../util/function-registry.js";
import { Logger } from "../util/logger.js";

const log = Logger.getInstance();

export interface Composable {
    /**
     * Annotation for the initialize() method to tell the system to preload this composable function:
     * @preload(route, instances, isPublic, isInterceptor)
     */
    initialize(): Composable;

    handleEvent(evt: EventEnvelope): Promise<string | boolean | number | object | EventEnvelope | null>;
}

/**
 * Annotation for a composable class
 * 
 * @param route name (aka functional topic)
 * @param instances to define concurrency
 * @param isPublic is true if this function is reachable thru event-over-http
 * @param isInterceptor is true if this function is an event interceptor
 * @returns annotated function
 */
export function preload(route, instances=1, isPublic=false, isInterceptor=false)  {
  return function (_target, propertyKey: string, descriptor: PropertyDescriptor) {
    if ('initialize' == propertyKey) {
      const method = descriptor.value;
      descriptor.value = function (...args) {
        if (this.handleEvent instanceof Function) {
            const registry = FunctionRegistry.getInstance();
            registry.saveFunction(route, this, Math.min(500, Math.max(1, instances)), isPublic, isInterceptor); 
        } else {
            log.error(`Unable to load ${this.constructor.name} because it does not implement Composable`);
        }
        return method.apply(this, args);
      };
    } else {
        log.error(`Please annotate the 'initialize' method in a Composable - @preload does not apply to ${propertyKey}`);
    }
  };
}


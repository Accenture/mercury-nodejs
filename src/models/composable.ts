import { EventEnvelope } from "./event-envelope.js";
import { FunctionRegistry } from "../system/function-registry.js";
import { Logger } from "../util/logger.js";

const log = Logger.getInstance();

export interface Composable {

    /**
     * Annotation for the initialize() method to tell the system to preload this composable function:
     * @preload(route, instances, isPublic, isInterceptor)
     * 
     * You can use the initialize method to do optional setup for your composable function.
     */
    initialize(): Composable;

    /**
     * This is your user function's entry point.
     * 
     * IMPORTANT: 
     * The 'this' reference is not relevant in a composable function
     * because Composable function is designed to be isolated with I/O immutability.
     * 
     * If your function needs to call other private methods in the same composable class,
     * use the PostOffice's getMyClass method like this:
     * 
     * // Creates a unique instance of PostOffice for your function
     * const po = new PostOffice(evt.getHeaders()); 
     * const self = po.getMyClass() as UserFunction; 
     * // where UserFunction should be the same as your composable class name.
     * 
     * @param evt is the incoming event containing headers and body (payload)
     */
    handleEvent(evt: EventEnvelope): Promise<string | boolean | number | object | EventEnvelope | null>;
}

/**
 * Annotation for a composable class
 * 
 * @param route name (aka functional topic)
 * @param instances to define concurrency
 * @param isPrivate is false if this function is reachable thru event-over-http
 * @param isInterceptor is true if this function is an event interceptor
 * @returns annotated function
 */
export function preload(route, instances=1, isPrivate=true, isInterceptor=false)  {
  return function (_target, propertyKey: string, descriptor: PropertyDescriptor) {
    if ('initialize' == propertyKey) {
      const method = descriptor.value;
        descriptor.value = function (...args) {
        const registry = FunctionRegistry.getInstance();
        registry.save(route, this, Math.min(500, Math.max(1, instances)), isPrivate, isInterceptor); 
        return method.apply(this, args);
      };
    } else {
        log.error(`Please annotate the 'initialize' method in a Composable - @preload does not apply to ${propertyKey}`);
    }
  };
}

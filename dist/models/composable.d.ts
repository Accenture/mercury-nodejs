import { EventEnvelope } from "./event-envelope.js";
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
export declare function preload(route: any, instances?: number, isPublic?: boolean, isInterceptor?: boolean): (_target: any, propertyKey: string, descriptor: PropertyDescriptor) => void;

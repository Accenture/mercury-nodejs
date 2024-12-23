import { EventEnvelope } from "./event-envelope.js";
export interface Composable {
    name: string;
    /**
     * @preload() - the preload annotation applies only to the initialize method
     */
    initialize(): void;
    getName(): string;
    handleEvent(evt: EventEnvelope): Promise<string | boolean | number | object | EventEnvelope | null>;
}
/**
 * Annotation for a composable class
 *
 * @param instances to define concurrency
 * @param isPublic is true if this function is reachable thru event-over-http
 * @param isInterceptor is true if this function is an event interceptor
 * @returns annotated function
 */
export declare function preload(instances?: number, isPublic?: boolean, isInterceptor?: boolean): (_target: any, propertyKey: string, descriptor: PropertyDescriptor) => void;

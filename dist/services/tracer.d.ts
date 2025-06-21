import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class DistributedTrace implements Composable {
    static readonly routeName = "distributed.tracing";
    initialize(): Composable;
    handleEvent(evt: EventEnvelope): Promise<any>;
}

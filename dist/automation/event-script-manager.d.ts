import { EventEnvelope } from '../models/event-envelope.js';
import { Composable } from '../models/composable.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class EventScriptEngine {
    start(): Promise<void>;
}
export declare class EventScriptManager implements Composable {
    initialize(): Composable;
    handleEvent(event: EventEnvelope): Promise<any>;
    private processRequest;
    private getFlowInstance;
}

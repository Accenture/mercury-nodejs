import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class ActuatorServices implements Composable {
    initialize(): Composable;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
    static doRoutes(): Promise<EventEnvelope>;
    static doEnv(): Promise<EventEnvelope>;
    static doInfo(): Promise<EventEnvelope>;
    static doHealthChecks(): Promise<EventEnvelope>;
}

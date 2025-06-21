import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class EventApiService implements Composable {
    static readonly routeName = "event.api.service";
    initialize(): Composable;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
}

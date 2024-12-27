import { EventEnvelope } from '../models/event-envelope.js';
import { Composable } from '../models/composable.js';
export declare class NoOp implements Composable {
    initialize(): NoOp;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
}

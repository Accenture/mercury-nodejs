import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class NoOp implements Composable {
    initialize(): NoOp;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
}

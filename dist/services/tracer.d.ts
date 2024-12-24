import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class DistributedTrace implements Composable {
    static name: string;
    initialize(): DistributedTrace;
    handleEvent(evt: EventEnvelope): Promise<any>;
}

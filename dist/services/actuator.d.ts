import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class ActuatorServices implements Composable {
    name: string;
    constructor();
    initialize(): void;
    getName(): string;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
    static doInfo(): Promise<EventEnvelope>;
    static doHealthChecks(): Promise<EventEnvelope>;
}

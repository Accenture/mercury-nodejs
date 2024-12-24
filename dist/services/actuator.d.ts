import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class ActuatorServices implements Composable {
    static name: string;
    initialize(): ActuatorServices;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
    static doInfo(): Promise<EventEnvelope>;
    static doHealthChecks(): Promise<EventEnvelope>;
}

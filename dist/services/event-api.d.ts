import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class EventApiService implements Composable {
    static name: string;
    initialize(): EventApiService;
    handleEvent(evt: EventEnvelope): Promise<EventEnvelope>;
    static eventApiError(status: number, message: string): EventEnvelope;
}

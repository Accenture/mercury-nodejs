import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class AsyncHttpClient implements Composable {
    static name: string;
    initialize(): AsyncHttpClient;
    handleEvent(evt: EventEnvelope): Promise<any>;
}

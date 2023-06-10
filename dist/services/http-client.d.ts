import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class HttpClientService implements Composable {
    name: string;
    getName(): string;
    handleEvent(evt: EventEnvelope): Promise<any>;
}

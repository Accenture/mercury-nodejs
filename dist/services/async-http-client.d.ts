import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class AsyncHttpClient implements Composable {
    static readonly routeName = "async.http.request";
    initialize(): Composable;
    handleEvent(evt: EventEnvelope): Promise<any>;
}

import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class TemporaryInbox implements Composable {
    static routeName: string;
    initialize(): Composable;
    static setPromise(cid: string, map: object): void;
    static clearPromise(cid: string): void;
    handleEvent(response: EventEnvelope): Promise<any>;
}

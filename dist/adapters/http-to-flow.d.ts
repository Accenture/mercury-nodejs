import { EventEnvelope } from '../models/event-envelope.js';
import { Composable } from '../models/composable.js';
import { PostOffice } from '../system/post-office.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class HttpToFlow implements Composable {
    initialize(): Composable;
    handleEvent(evt: EventEnvelope): Promise<any>;
    processRequest(po: PostOffice, evt: EventEnvelope, cid: string): Promise<void>;
}

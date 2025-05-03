import { EventEnvelope } from '../models/event-envelope.js';
import { Composable } from '../models/composable.js';
import { PostOffice } from '../system/post-office.js';
export declare class ResilienceHandler implements Composable {
    initialize(): Composable;
    handleEvent(event: EventEnvelope): Promise<boolean>;
    sendResult(po: PostOffice, replyTo: string, cid: string, result: any, delay: number): void;
}

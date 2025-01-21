import { EventEnvelope } from '../models/event-envelope.js';
import { PostOffice } from '../system/post-office.js';
export declare class FlowExecutor {
    private static singleton;
    private constructor();
    static getInstance(): FlowExecutor;
    launch(po: PostOffice, flowId: string, dataset: object, correlationId: string, callback?: string): Promise<void>;
    request(po: PostOffice, flowId: string, dataset: object, correlationId: string, timeout: number): Promise<EventEnvelope>;
}

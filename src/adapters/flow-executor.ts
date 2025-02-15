import { EventEnvelope } from '../models/event-envelope.js';
import { Utility } from '../util/utility.js';
import { PostOffice } from '../system/post-office.js';

const util = new Utility();
const FLOW_ID = 'flow_id';
const BODY = 'body';
const EVENT_MANAGER = "event.script.manager";

export class FlowExecutor {
    private static singleton: FlowExecutor;

    private constructor() {}

    static getInstance(): FlowExecutor {
        if (FlowExecutor.singleton === undefined) {
            FlowExecutor.singleton = new FlowExecutor();
        }
        return FlowExecutor.singleton;
    }

    async launch(po: PostOffice, flowId: string, dataset: object, correlationId: string, callback?: string) {
        if (BODY in dataset) {
            const forward = new EventEnvelope().setTo(EVENT_MANAGER).setHeader(FLOW_ID, flowId);
            forward.setCorrelationId(correlationId).setBody(dataset);
            if (callback) {
                forward.setReplyTo(callback);
            }
            await po.send(forward);
        } else {
            throw new Error("Missing body in dataset");
        }
    }

    async request(po: PostOffice, flowId: string, dataset: object, correlationId: string, timeout: number) {
        const ms = Math.max(10, util.str2int(String(timeout)));
        if (BODY in dataset) {
            const forward = new EventEnvelope().setTo(EVENT_MANAGER).setHeader(FLOW_ID, flowId);
            forward.setCorrelationId(correlationId).setBody(dataset);
            return await po.request(forward, ms);
        } else {
            throw new Error("Missing body in dataset");
        }
    }
}

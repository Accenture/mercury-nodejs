import { EventEnvelope } from '../models/event-envelope.js';
import { Utility } from '../util/utility.js';
const util = new Utility();
const FLOW_ID = 'flow_id';
const BODY = 'body';
const EVENT_MANAGER = "event.script.manager";
export class FlowExecutor {
    static singleton;
    constructor() { }
    static getInstance() {
        if (FlowExecutor.singleton === undefined) {
            FlowExecutor.singleton = new FlowExecutor();
        }
        return FlowExecutor.singleton;
    }
    async launch(po, flowId, dataset, correlationId, callback) {
        if (BODY in dataset) {
            const forward = new EventEnvelope().setTo(EVENT_MANAGER).setHeader(FLOW_ID, flowId);
            forward.setCorrelationId(correlationId).setBody(dataset);
            if (callback) {
                forward.setReplyTo(callback);
            }
            await po.send(forward);
        }
        else {
            throw new Error("Missing body in dataset");
        }
    }
    async request(po, flowId, dataset, correlationId, timeout) {
        const ms = Math.max(10, util.str2int(String(timeout)));
        if (BODY in dataset) {
            const forward = new EventEnvelope().setTo(EVENT_MANAGER).setHeader(FLOW_ID, flowId);
            forward.setCorrelationId(correlationId).setBody(dataset);
            return await po.request(forward, ms);
        }
        else {
            throw new Error("Missing body in dataset");
        }
    }
}
//# sourceMappingURL=flow-executor.js.map
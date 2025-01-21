import { Utility } from '../util/utility.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from './event-envelope.js';
const TIMEOUT = "timeout";
const util = new Utility();
const po = new PostOffice();
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class FlowInstance {
    dataset = {};
    tasks = [];
    pendingTasks = {};
    pipeCounter = 0;
    pipeMap = {};
    start = new Date();
    id = util.getUuid();
    cid;
    replyTo;
    timeoutWatcher;
    flow;
    traceId;
    tracePath;
    responded = false;
    running = true;
    constructor(flowId, cid, replyTo, flow) {
        this.flow = flow;
        this.cid = cid;
        this.replyTo = replyTo;
        // initialize the state machine
        const model = { 'instance': this.id, 'cid': cid, 'flow': flowId };
        this.dataset['model'] = model;
        const timeoutTask = new EventEnvelope().setTo('task.executor');
        timeoutTask.setCorrelationId(this.id).setHeader(TIMEOUT, 'true');
        this.timeoutWatcher = po.sendLater(timeoutTask, flow.ttl);
    }
    setTrace(traceId, tracePath) {
        this.traceId = traceId;
        this.tracePath = tracePath;
        if (traceId) {
            const model = this.dataset['model'];
            model['trace'] = traceId;
        }
    }
    getStartMillis() {
        return this.start.getTime();
    }
    close() {
        if (this.running) {
            this.running = false;
            po.cancelFutureEvent(this.timeoutWatcher);
        }
    }
    isNotResponded() {
        return !this.responded;
    }
    setResponded(responded) {
        this.responded = responded;
    }
    getTraceId() {
        return this.traceId;
    }
    setTraceId(traceId) {
        this.traceId = traceId;
    }
    getTracePath() {
        return this.tracePath;
    }
    setTracePath(tracePath) {
        this.tracePath = tracePath;
    }
    getFlow() {
        return this.flow;
    }
}
//# sourceMappingURL=flow_instance.js.map
import { Flows } from './flows.js';
import { Utility } from '../util/utility.js';
import { Logger } from '../util/logger.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from './event-envelope.js';
const TIMEOUT = "timeout";
const util = new Utility();
const po = new PostOffice();
const log = Logger.getInstance();
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class FlowInstance {
    dataset = {};
    shared = {};
    tasks = [];
    pendingTasks = {};
    pipeCounter = 0;
    pipeMap = {};
    start = new Date();
    id = util.getUuid();
    cid;
    replyTo;
    timeoutWatcher;
    template;
    parentId;
    traceId;
    tracePath;
    responded = false;
    topLevelException = false;
    running = true;
    constructor(flowId, cid, replyTo, template, parentId) {
        this.template = template;
        this.cid = cid;
        this.replyTo = replyTo;
        // initialize the state machine
        const model = { 'instance': this.id, 'cid': cid, 'flow': flowId };
        if (parentId) {
            const parent = this.resolveParent(parentId);
            if (parent) {
                model['parent'] = parent.shared;
                model['root'] = parent.shared;
                this.parentId = parent.id;
                log.info(`${this.getFlow().id}:${this.id} extends ${parent.getFlow().id}:${parent.id}`);
            }
        }
        else {
            // this is a sub-flow if parent flow instance is available
            this.parentId = null;
            model['parent'] = this.shared;
            model['root'] = this.shared;
        }
        this.dataset['model'] = model;
        const timeoutTask = new EventEnvelope().setTo('task.executor');
        timeoutTask.setCorrelationId(this.id).setHeader(TIMEOUT, 'true');
        this.timeoutWatcher = po.sendLater(timeoutTask, template.ttl);
    }
    resolveParent(parentId) {
        const parent = Flows.getFlowInstance(parentId);
        if (parent) {
            const pid = parent.parentId;
            if (pid) {
                return this.resolveParent(pid);
            }
            else {
                return parent;
            }
        }
        else {
            return null;
        }
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
    topLevelExceptionHappened() {
        return this.topLevelException;
    }
    setExceptionAtTopLevel(state) {
        this.topLevelException = state;
    }
    getFlow() {
        return this.template;
    }
}
//# sourceMappingURL=flow_instance.js.map